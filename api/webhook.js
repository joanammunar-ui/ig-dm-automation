// api/webhook.js
import fetch from 'node-fetch';
import { google } from 'googleapis';

// Env vars (poner en Vercel)
const VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN;
const PAGE_ID = process.env.FB_PAGE_ID;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GSHEET_ID = process.env.GSHEET_ID;
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64; // base64 del JSON
const TEMPLATES_JSON = process.env.TEMPLATES_JSON_BASE64 || null;
const WA_LINK = process.env.WA_LINK || 'https://wa.me/34TU_NUMERO?text=Hola%20Joana';

// Sheets client
function getSheetsClient() {
  const keyJson = JSON.parse(Buffer.from(SERVICE_ACCOUNT_JSON, 'base64').toString('utf8'));
  const jwt = new google.auth.JWT(
    keyJson.client_email,
    null,
    keyJson.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth: jwt });
}

async function appendRow(row) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: GSHEET_ID,
    range: 'Leads!A1',
    valueInputOption: 'RAW',
    requestBody: { values: [row] }
  });
}

// Load templates
const defaultTemplates = {
  viajes: { initial: "Hola {nombre} ✈️ — gracias por comentar en «{post_titulo}». ¿maleta ligera o todo incluido?", followup_48h: "Hola {nombre} — ¿te mando la mini-guía por aquí o prefieres WhatsApp? {wa_link}", followup_7d: "Hola {nombre} — si quieres la guía solo di 'sí' y te la paso.", derivation: "Te lo paso por WhatsApp: {wa_link}" },
  crecimiento: { initial: "Hola {nombre} 🌱 — gracias por comentar. ¿Quieres una mini-rutina de 5 minutos?", followup_48h: "Hola {nombre}, ¿te interesa la guía de 30 días? {form_link}", followup_7d: "Hola {nombre} — si quieres la rutina adaptada dímelo y te la envío.", derivation: "Descarga la guía: {form_link} o escríbeme por WhatsApp: {wa_link}" },
  negocio: { initial: "Hola {nombre} 🚀 — gracias por comentar. ¿Quieres la plantilla para validar en 7 días?", followup_48h: "Hola {nombre}, ¿te la envío por WhatsApp? {wa_link}", followup_7d: "Hola {nombre} — ¿te doy feedback en 3 líneas si me cuentas tu idea?", derivation: "Validemos por WhatsApp: {wa_link} o descarga aquí: {form_link}" }
};
let templates = defaultTemplates;
if (TEMPLATES_JSON) {
  try { templates = JSON.parse(Buffer.from(TEMPLATES_JSON, 'base64').toString('utf8')); } catch(e) { console.error('templates parse err', e); }
}

function fillTemplate(str, vars={}) {
  return (str || '').replace(/\{(\w+)\}/g, (_, k) => vars[k] || '');
}

async function sendPrivateReplyToComment(commentId, text) {
  const url = `https://graph.facebook.com/v17.0/${PAGE_ID}/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  const body = { recipient: { comment_id: commentId }, message: { text } };
  const res = await fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }});
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function sendMessageToUserByPSID(psid, text) {
  const url = `https://graph.facebook.com/v17.0/${PAGE_ID}/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  const body = { recipient: { id: psid }, message: { text } };
  const res = await fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }});
  const data = await res.json();
  if (!res.ok) console.error('send msg err', data);
  return data;
}

function classifyText(text) {
  const t = (text || '').toLowerCase();
  if (t.match(/viaje|destino|crucero|ruta|vuelo|maleta/)) return 'viajes';
  if (t.match(/rutina|hábito|habito|mentalidad|reto|30/)) return 'crecimiento';
  if (t.match(/lanzo|lanzamiento|curso|emprend|funnel|webinar|email|venta/)) return 'negocio';
  return 'unknown';
}

// Handler
export default async function handler(req, res) {
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode && token) {
      if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
      return res.status(403).send('Verification failed');
    }
    return res.status(400).send('No mode/token');
  }

  if (req.method === 'POST') {
    try {
      const body = req.body;
      if (!body.entry) return res.status(200).send('no entry');

      for (const entry of body.entry) {
        if (entry.changes) {
          for (const change of entry.changes) {
            if (change.field === 'comments' && change.value) {
              const c = change.value;
              const commentId = c.id || c.comment_id || (c.comment && c.comment.id) || null;
              const text = c.text || c.message || '';
              const username = (c.from && c.from.username) || c.username || c.from_name || 'amigo';

              const bucket = classifyText(text);
              const usedBucket = templates[bucket] ? bucket : 'viajes';
              const replyText = fillTemplate(templates[usedBucket].initial, { nombre: username, post_titulo: c.media && c.media.caption || 'tu post', wa_link: WA_LINK });

              try { if (commentId) await sendPrivateReplyToComment(commentId, replyText); } catch(e) { console.error('private reply error', e); }

              const now = new Date().toISOString();
              const row = [now, username, commentId, text, 'comment', usedBucket, replyText];
              try { await appendRow(row); } catch(e) { console.error('sheet append err', e); }
            }
          }
        }

        if (entry.messaging) {
          for (const m of entry.messaging) {
            const sender = m.sender && m.sender.id;
            const message = m.message && (m.message.text || '');
            const intent = classifyText(message);
            const now = new Date().toISOString();
            const row = [now, sender, '', message, 'message', intent];
            try { await appendRow(row); } catch(e) { console.error('sheet append err', e); }

            if (message && !message.toLowerCase().includes('gracias')) {
              const follow = "Gracias por contestar — te puedo enviar una guía breve. ¿Prefieres WhatsApp o formulario?";
              try { await sendMessageToUserByPSID(sender, follow); } catch(e) { console.error('send msg err', e); }
            }
          }
        }
      }

      return res.status(200).send('EVENT_RECEIVED');
    } catch (err) {
      console.error(err);
      return res.status(500).send('ERR');
    }
  }

  res.setHeader('Allow', ['GET','POST']);
  res.status(405).end('Method Not Allowed');
}

import fs from "node:fs/promises";
import crypto from "node:crypto";

function parseSetCookie(headers) {
  const out = [];
  const raw = headers.getSetCookie ? headers.getSetCookie() : (headers.get("set-cookie") ? [headers.get("set-cookie")] : []);
  for (const c of raw) out.push(c.split(";")[0]);
  return out;
}
function cookieHeader(cookies) { return [...cookies.entries()].map(([k,v]) => `${k}=${v}`).join("; "); }
function mergeCookies(cookies, headers) {
  for (const part of parseSetCookie(headers)) {
    const i = part.indexOf("=");
    if (i > 0) cookies.set(part.slice(0,i), part.slice(i+1));
  }
}
function htmlDecode(s) { return s.replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&amp;", "&"); }
function extractCsrf(html) {
  return html.match(/name=["']csrfmiddlewaretoken["'][^>]*value=["']([^"']+)/)?.[1]
    || html.match(/value=["']([^"']+)["'][^>]*name=["']csrfmiddlewaretoken/)?.[1];
}
function extractJsVar(html, name) {
  const m = html.match(new RegExp(`var\\s+${name}\\s*=\\s*["']([^"']+)["']`));
  return m ? htmlDecode(m[1]) : null;
}

export class EvenniaClient {
  constructor(account, log) {
    this.account = account;
    this.log = log;
    this.cookies = new Map();
    this.handlers = [];
    this.ws = null;
  }
  onEvent(fn) { this.handlers.push(fn); }
  async connect() {
    const password = (await fs.readFile(this.account.passwordFile, "utf8")).trim();
    const loginUrl = `${this.account.baseUrl}/auth/login/`;
    let res = await fetch(loginUrl);
    mergeCookies(this.cookies, res.headers);
    const loginHtml = await res.text();
    const csrf = extractCsrf(loginHtml);
    const body = new URLSearchParams({ username: this.account.username, password, csrfmiddlewaretoken: csrf || "", next: "" });
    res = await fetch(loginUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cookie": cookieHeader(this.cookies), "referer": loginUrl },
      body,
      redirect: "manual"
    });
    mergeCookies(this.cookies, res.headers);
    if (![200,302,303].includes(res.status)) throw new Error(`Evennia login failed: HTTP ${res.status}`);

    res = await fetch(`${this.account.baseUrl}/webclient/`, { headers: { cookie: cookieHeader(this.cookies) } });
    mergeCookies(this.cookies, res.headers);
    const html = await res.text();
    const csessid = extractJsVar(html, "csessid") || this.cookies.get("sessionid") || crypto.randomUUID();
    const cuid = extractJsVar(html, "cuid") || crypto.randomUUID();
    const browser = "openclaw-evennia";
    const url = `${this.account.websocketUrl}/?${encodeURIComponent(csessid)}&${encodeURIComponent(cuid)}&${encodeURIComponent(browser)}`;
    this.ws = new WebSocket(url, "v1.evennia.com");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Evennia websocket timeout")), 10000);
      this.ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener("error", (ev) => { clearTimeout(timer); reject(new Error("Evennia websocket error")); }, { once: true });
    });
    this.ws.addEventListener("message", (ev) => this.handleMessage(String(ev.data)));
  }
  close() { try { this.ws?.close(); } catch {} }
  isClosed() { return !this.ws || this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED; }
  async command(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("Evennia websocket is not open");
    this.ws.send(JSON.stringify(["text", [text], {}]));
  }
  async say(text) {
    const safe = String(text).replace(/\s+/g, " ").trim();
    await this.command(`say ${safe}`);
  }
  async tell(target, text) {
    const safeTarget = String(target).replace(/[=\n\r]/g, " ").trim();
    const safe = String(text).replace(/\s+/g, " ").trim();
    await this.command(`tell ${safeTarget} = ${safe}`);
  }
  async whisper(target, text) {
    const safeTarget = String(target).replace(/[=\n\r]/g, " ").trim();
    const safe = String(text).replace(/\s+/g, " ").trim();
    await this.command(`whisper ${safeTarget} = ${safe}`);
  }
  handleMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!Array.isArray(msg) || msg[0] !== "text") return;
    const text = flattenText(msg[1]).trim();
    if (!text) return;
    const parsed = parseEvenniaText(text);
    if (!parsed) return;
    const event = { id: crypto.randomUUID(), timestamp: Date.now(), raw: msg, ...parsed };
    for (const h of this.handlers) h(event);
  }
}

function flattenText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenText).join("\n");
  if (value && typeof value === "object") return "";
  return "";
}
function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ""); }
function stripHtml(s) {
  return s
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
function parseEvenniaText(text) {
  const clean = stripHtml(stripAnsi(text)).replace(/\r/g, "").trim();
  let m = clean.match(/^Account\s+([^\n:]+)\s+pages:\s*(.*)$/is);
  if (m) return { kind: "tell", sender: m[1].trim(), text: m[2].trim(), replyMode: "tell" };
  m = clean.match(/^([^\n:]+)\s+tells you,\s*["“](.*)["”]$/is);
  if (m) return { kind: "tell", sender: m[1].trim(), text: m[2].trim(), replyMode: "tell" };
  m = clean.match(/^([^\n:]+)\s+whispers:\s*["“](.*)["”]$/is);
  if (m) return { kind: "whisper", sender: m[1].trim(), room: "current", text: m[2].trim(), replyMode: "whisper" };
  m = clean.match(/^([^\n:]+)\s+says,\s*["“](.*)["”]$/is);
  if (m) return { kind: "say", sender: m[1].trim(), room: "current", text: m[2].trim(), replyMode: "say" };
  return null;
}

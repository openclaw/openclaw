#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const baseUrl = process.env.MC_TEST_BASE_URL || "http://127.0.0.1:3001";
const apiKey = process.env.MC_TEST_API_KEY || "";
const outputDir = path.resolve(process.cwd(), "output/playwright");
const CSRF_COOKIE_NAME = "mc_csrf";

let csrfToken = "";
let csrfCookie = "";

async function ensureCsrf() {
  if (csrfToken && csrfCookie) {return;}
  const response = await fetch(new URL("/api/csrf-token", baseUrl));
  if (!response.ok) {
    throw new Error(`Failed to initialize CSRF token: ${response.status}`);
  }
  const setCookie = response.headers.get("set-cookie") || "";
  const match = setCookie.match(new RegExp(`${CSRF_COOKIE_NAME}=([^;]+)`));
  if (!match) {
    throw new Error("Missing CSRF cookie from /api/csrf-token");
  }
  csrfToken = decodeURIComponent(match[1]);
  csrfCookie = `${CSRF_COOKIE_NAME}=${match[1]}`;
}

/**
 * @param {string} route
 * @param {RequestInit & { auth?: boolean }} [init]
 */
async function request(route, init = {}) {
  const headers = new Headers(init.headers || {});
  const method = (init.method || "GET").toUpperCase();
  if (init.auth && apiKey) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  if (!headers.has("content-type") && init.body) {
    headers.set("content-type", "application/json");
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    await ensureCsrf();
    headers.set("x-csrf-token", csrfToken);
    const existingCookie = headers.get("cookie");
    headers.set("cookie", [existingCookie, csrfCookie].filter(Boolean).join("; "));
  }

  const startedAt = Date.now();
  const response = await fetch(new URL(route, baseUrl), {
    ...init,
    headers,
  });
  const elapsedMs = Date.now() - startedAt;

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { response, data, elapsedMs };
}

await fs.mkdir(outputDir, { recursive: true });

const results = [];
let failed = false;

const sessionKey = `agent:main:mission-control:chat-e2e-${Date.now()}`;

// 1) List sessions.
const sessions = await request("/api/chat/sessions?limit=20", { auth: true });
const sessionsPass = sessions.response.status === 200;
results.push({
  name: "list_sessions",
  pass: sessionsPass,
  status: sessions.response.status,
  elapsedMs: sessions.elapsedMs,
});
if (!sessionsPass) {failed = true;}

// 2) Send a chat message (streaming/queued path).
const send = await request("/api/chat", {
  method: "POST",
  auth: true,
  body: JSON.stringify({
    sessionKey,
    message: "chat e2e smoke message",
  }),
});
const sendPass = [200, 202].includes(send.response.status) || send.response.status === 503;
results.push({
  name: "send_message_non_blocking",
  pass: sendPass,
  status: send.response.status,
  elapsedMs: send.elapsedMs,
  body: send.data,
});
if (!sendPass) {failed = true;}

// 3) Read chat history for same session key.
const history = await request(`/api/chat?sessionKey=${encodeURIComponent(sessionKey)}&limit=20`, {
  auth: true,
});
const historyPass = history.response.status === 200 || history.response.status === 503;
results.push({
  name: "read_chat_history",
  pass: historyPass,
  status: history.response.status,
  elapsedMs: history.elapsedMs,
});
if (!historyPass) {failed = true;}

// 4) Update session metadata.
const patchSession = await request("/api/chat/sessions", {
  method: "PATCH",
  auth: true,
  body: JSON.stringify({
    sessionKey,
    model: null,
  }),
});
const patchPass = patchSession.response.status === 200 || patchSession.response.status === 503;
results.push({
  name: "patch_session_metadata",
  pass: patchPass,
  status: patchSession.response.status,
  elapsedMs: patchSession.elapsedMs,
});
if (!patchPass) {failed = true;}

// 5) Delete session.
const deleteSession = await request("/api/chat/sessions", {
  method: "DELETE",
  auth: true,
  body: JSON.stringify({
    sessionKey,
  }),
});
const deletePass = deleteSession.response.status === 200 || deleteSession.response.status === 503;
results.push({
  name: "delete_session",
  pass: deletePass,
  status: deleteSession.response.status,
  elapsedMs: deleteSession.elapsedMs,
});
if (!deletePass) {failed = true;}

const outputPath = path.join(outputDir, "chat-e2e-smoke-results.json");
await fs.writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");

const summary = {
  total: results.length,
  failed: results.filter((r) => !r.pass).length,
};

console.log(`Chat e2e smoke summary: ${JSON.stringify(summary)}`);
console.log(`Details: ${outputPath}`);

if (failed) {process.exit(1);}

#!/usr/bin/env node
// bridge.mjs — safeTok NIP-44 ↔ OpenClaw bidirectional bridge
//
// Listens on Nostr relays for incoming safeTok DMs (kind:4, NIP-44 v3 variant),
// routes them to a dedicated OpenClaw session, and publishes the encrypted reply back.
//
// Usage:
//   npm install @noble/curves   ← one-time install
//   OPENCLAW_TOKEN=<gateway-token> SAFETOK_PRIVATE_KEY=<hex> node bridge.mjs
//
// Environment variables:
//   OPENCLAW_TOKEN        Required. Gateway auth token (from gateway.token in config).
//   SAFETOK_PRIVATE_KEY   Required. Bot private key (hex, 64 chars).
//   OPENCLAW_GW_URL       Optional. Gateway WebSocket URL. Default: ws://127.0.0.1:18789
//   SAFETOK_RELAYS        Optional. Comma-separated relay URLs.
//                         Default: wss://relay.damus.io,wss://nos.lol
//   SAFETOK_SESSION       Optional. OpenClaw session key. Default: agent:dev:safetok-bridge

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encrypt, decrypt, buildDmEvent, privToXOnlyPub } from "./nip44.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Config from environment ──────────────────────────────────────────────────
const GW_URL = process.env.OPENCLAW_GW_URL ?? "ws://127.0.0.1:18789";
const GW_TOKEN = process.env.OPENCLAW_TOKEN;
const MY_PRIV = process.env.SAFETOK_PRIVATE_KEY;
const SESSION = process.env.SAFETOK_SESSION ?? "agent:dev:safetok-bridge";
const RELAYS = (process.env.SAFETOK_RELAYS ?? "wss://relay.damus.io,wss://nos.lol")
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);

if (!GW_TOKEN) {
  console.error("[bridge] OPENCLAW_TOKEN is required");
  process.exit(1);
}
if (!MY_PRIV) {
  console.error("[bridge] SAFETOK_PRIVATE_KEY is required");
  process.exit(1);
}

const MY_PUB = privToXOnlyPub(MY_PRIV);

// Look back 5 minutes on restart so DMs sent during downtime aren't permanently missed.
// The `seen` set (persisted to disk) deduplicates anything we already replied to.
const STARTUP_TS = Math.floor(Date.now() / 1000);
const LOOKBACK_SECS = 300;
const MAX_AGE_REPLY = 120; // skip DMs older than 2 min at startup (already stale)
const SINCE = STARTUP_TS - LOOKBACK_SECS;

// Persist seen IDs to disk so restarts don't reprocess already-handled DMs
const SEEN_FILE = join(__dir, "seen-events.json");
function loadSeen() {
  try {
    if (existsSync(SEEN_FILE)) {
      const ids = JSON.parse(readFileSync(SEEN_FILE, "utf8"));
      return new Set(Array.isArray(ids) ? ids : []);
    }
  } catch {}
  return new Set();
}
function saveSeen(s) {
  const arr = [...s];
  try {
    writeFileSync(SEEN_FILE, JSON.stringify(arr.slice(-2000)));
  } catch {}
}

const seen = loadSeen();
const dmQueue = [];
let dmProcessing = false;
const pending = new Map();

// ── Gateway client ──────────────────────────────────────────────────────────
let gw = null,
  gwReady = false;
const gwQueue = [];

function gwRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    pending.set(id, { resolve, reject });
    const frame = JSON.stringify({ type: "req", id, method, params });
    if (gwReady) gw.send(frame);
    else gwQueue.push(frame);
  });
}

function gwConnect() {
  console.log("[bridge] connecting to OpenClaw gateway…");
  gw = new WebSocket(GW_URL);

  gw.addEventListener("open", () => {
    gw.send(
      JSON.stringify({
        type: "req",
        id: randomUUID(),
        method: "connect",
        params: {
          minProtocol: 1,
          maxProtocol: 5,
          client: {
            id: "gateway-client",
            displayName: "safeTok Bridge",
            version: "1.0.0",
            platform: "node",
            mode: "backend",
          },
          auth: { token: GW_TOKEN },
          scopes: ["operator.read", "operator.write"],
        },
      }),
    );
  });

  gw.addEventListener("message", ({ data }) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type !== "res") return;
    if (!gwReady) {
      gwReady = true;
      console.log("[bridge] gateway ready ✓");
      for (const f of gwQueue.splice(0)) gw.send(f);
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.payload ?? msg.result);
    else p.reject(new Error(msg.error?.message ?? "gateway error"));
  });

  gw.addEventListener("close", () => {
    gwReady = false;
    console.log("[bridge] gateway disconnected — reconnecting in 5s…");
    setTimeout(gwConnect, 5000);
  });

  gw.addEventListener("error", ({ message }) => console.error("[bridge] gateway error:", message));
}

// ── Ensure dedicated bridge session exists ───────────────────────────────────
async function ensureBridgeSession() {
  try {
    await gwRequest("sessions.create", { key: SESSION, agentId: "dev" });
    console.log(`[bridge] created dedicated session: ${SESSION}`);
  } catch (e) {
    console.log(`[bridge] session ready (${e.message ?? "exists"})`);
  }
}

// ── Get reply from OpenClaw ──────────────────────────────────────────────────
async function getReply(plaintext, senderPub) {
  const prompt = `[safeTok DM from ${senderPub.slice(0, 16)}…]\n${plaintext}`;

  function extractText(m) {
    if (Array.isArray(m.content)) {
      return m.content
        .filter((b) => b?.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
        .trim();
    }
    return (m.text ?? m.content ?? "").trim();
  }

  let baselineCount = 0;
  let baselineLastTs = 0;
  try {
    const hist = await gwRequest("chat.history", { sessionKey: SESSION, limit: 50 });
    const msgs = hist?.messages ?? hist?.entries ?? hist ?? [];
    baselineCount = msgs.length;
    const lastAsst = [...msgs]
      .reverse()
      .find((m) => m.role === "assistant" || m.type === "assistant");
    if (lastAsst) {
      baselineLastTs =
        lastAsst.timestamp ?? lastAsst.createdAt ?? lastAsst.__openclaw?.recordTimestampMs ?? 0;
    }
  } catch {}

  const sendAt = Date.now();

  const ack = await gwRequest("chat.send", {
    sessionKey: SESSION,
    message: prompt,
    deliver: false,
    idempotencyKey: randomUUID(),
  });

  const runId = ack?.runId ?? ack?.id;
  console.log(`[bridge] chat.send ack, runId=${runId ?? "(none)"}`);

  const deadline = Date.now() + 180_000; // 3 min
  while (Date.now() < deadline) {
    await sleep(4000);
    try {
      const hist = await gwRequest("chat.history", { sessionKey: SESSION, limit: 50 });
      const msgs = hist?.messages ?? hist?.entries ?? hist ?? [];

      const candidates = msgs.filter((m) => {
        if (m.role !== "assistant" && m.type !== "assistant") return false;
        const text = extractText(m);
        if (!text) return false;
        if (text.startsWith("HEARTBEAT_OK")) return false;
        if (text.startsWith("[bridge-test]")) return false;
        const ts = m.timestamp ?? m.createdAt ?? m.__openclaw?.recordTimestampMs ?? 0;
        if (baselineLastTs && ts <= baselineLastTs) return false;
        if (ts && ts < sendAt) return false;
        return true;
      });

      if (candidates.length > 0) {
        const last = candidates.at(-1);
        const text = extractText(last);
        const clean = text.replace(/\[\[reply_to_current\]\]/g, "").trim();
        if (clean) return clean;
      }
    } catch (e) {
      console.warn("[bridge] history poll error:", e.message);
    }
  }
  throw new Error("timeout waiting for assistant reply");
}

// ── Publish encrypted reply ──────────────────────────────────────────────────
async function publishReply(recipientPub, text) {
  const ev = await buildDmEvent(text, MY_PRIV, recipientPub);
  let ok = 0;
  await Promise.allSettled(
    RELAYS.map(
      (url) =>
        new Promise((res) => {
          const ws = new WebSocket(url);
          const t = setTimeout(() => {
            ws.close();
            res();
          }, 8000);
          ws.addEventListener("open", () => ws.send(JSON.stringify(["EVENT", ev])));
          ws.addEventListener("message", ({ data }) => {
            let m;
            try {
              m = JSON.parse(data);
            } catch {
              return;
            }
            if (m[0] === "OK") {
              clearTimeout(t);
              if (m[2]) {
                ok++;
                console.log(`[bridge] published to ${url}`);
              } else console.warn(`[bridge] ${url} rejected: ${m[3]}`);
              ws.close();
              res();
            }
          });
          ws.addEventListener("close", res);
          ws.addEventListener("error", res);
        }),
    ),
  );
  console.log(`[bridge] reply published to ${ok}/${RELAYS.length} relays`);
}

// ── Process incoming DM (sequential queue) ───────────────────────────────────
async function processDm(ev) {
  const age = STARTUP_TS - ev.created_at;

  let plain;
  try {
    plain = await decrypt(ev.content, MY_PRIV, ev.pubkey);
    console.log(`[bridge] decrypted: "${plain.slice(0, 100)}${plain.length > 100 ? "…" : ""}"`);
  } catch (e) {
    console.warn(`[bridge] decrypt failed: ${e.message}`);
    return;
  }

  if (age > MAX_AGE_REPLY) {
    console.log(`[bridge] skipping old DM (${age}s at startup > ${MAX_AGE_REPLY}s limit)`);
    return;
  }

  let reply;
  try {
    reply = await getReply(plain, ev.pubkey);
    console.log(`[bridge] → reply: "${reply.slice(0, 100)}${reply.length > 100 ? "…" : ""}"`);
  } catch (e) {
    console.error("[bridge] failed to get reply:", e.message);
    reply = "Oh dear — I encountered a malfunction. Please try again.";
  }

  await publishReply(ev.pubkey, reply);
}

async function drainQueue() {
  if (dmProcessing) return;
  dmProcessing = true;
  while (dmQueue.length > 0) {
    const ev = dmQueue.shift();
    await processDm(ev).catch((e) => console.error("[bridge] processDm error:", e.message));
  }
  dmProcessing = false;
}

function handleDm(ev) {
  if (seen.has(ev.id)) return;
  if (ev.pubkey === MY_PUB) {
    seen.add(ev.id);
    saveSeen(seen);
    return;
  }

  const age = Math.floor(Date.now() / 1000) - ev.created_at;
  console.log(`\n[bridge] ← DM from ${ev.pubkey.slice(0, 16)}… (${age}s ago)`);

  seen.add(ev.id);
  saveSeen(seen);

  dmQueue.push(ev);
  drainQueue().catch((e) => console.error("[bridge] queue error:", e.message));
}

// ── Subscribe to a relay ─────────────────────────────────────────────────────
function subscribeRelay(url) {
  const sub = "b-" + Math.random().toString(36).slice(2, 8);
  let ws,
    alive = true;

  function connect() {
    ws = new WebSocket(url);
    ws.addEventListener("open", () => {
      console.log(`[bridge] subscribed to ${url}`);
      ws.send(JSON.stringify(["REQ", sub, { kinds: [4], "#p": [MY_PUB], since: SINCE }]));
    });
    ws.addEventListener("message", ({ data }) => {
      let m;
      try {
        m = JSON.parse(data);
      } catch {
        return;
      }
      if (m[0] === "EVENT" && m[1] === sub) handleDm(m[2]);
    });
    ws.addEventListener("close", () => {
      if (!alive) return;
      console.log(`[bridge] ${url} closed — reconnecting in 15s…`);
      setTimeout(connect, 15000);
    });
    ws.addEventListener("error", () => {});
  }
  connect();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Start ────────────────────────────────────────────────────────────────────
console.log("╔═══════════════════════════════════════════════╗");
console.log("║   safeTok ↔ OpenClaw Bridge                  ║");
console.log("╚═══════════════════════════════════════════════╝");
console.log(`pubkey : ${MY_PUB}`);
console.log(`session: ${SESSION}`);
console.log(`relays : ${RELAYS.join(", ")}\n`);

gwConnect();
await sleep(2500);
await ensureBridgeSession();
for (const r of RELAYS) subscribeRelay(r);

process.on("SIGINT", () => {
  console.log("\n[bridge] stopped");
  process.exit(0);
});

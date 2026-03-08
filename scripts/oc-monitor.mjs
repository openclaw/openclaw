#!/usr/bin/env node
import crypto from "crypto";
import fs from "fs";
import path from "path";
/**
 * OpenClaw Gateway Monitor
 *
 * Live terminal dashboard showing channels, sessions, events.
 * Stays connected and refreshes on state changes.
 *
 * Usage:
 *   oc-monitor              # full dashboard
 *   oc-monitor --compact     # compact one-line status
 *   oc-monitor --events      # event stream only
 */
import WebSocket from "ws";

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789";
const IDENTITY_FILE = process.env.OPENCLAW_IDENTITY_FILE || "";
const IDENTITY_DIR = process.env.OPENCLAW_IDENTITY_DIR || "/home/node/.openclaw/identity";
const CONFIG_PATH = process.env.OPENCLAW_CONFIG || "/home/node/.openclaw/openclaw.json";

const args = new Set(process.argv.slice(2));
const compact = args.has("--compact");
const eventsOnly = args.has("--events");

const devicePath = IDENTITY_FILE || path.join(IDENTITY_DIR, "device.json");
const deviceConfig = JSON.parse(fs.readFileSync(devicePath, "utf-8"));
const openclawConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

const { deviceId, privateKeyPem, publicKeyPem } = deviceConfig;
const gatewayToken = openclawConfig.gateway?.auth?.token;
if (!gatewayToken) {
  console.error("[FATAL] gateway.auth.token not set");
  process.exit(1);
}

const spkiDer = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
const rawKey = spkiDer.subarray(spkiDer.length - 32);
const pubKeyB64Url = rawKey
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=/g, "");

// --- State ---
let channels = {};
let sessions = [];
let nodes = [];
let connId = "";
let _connectedAt = null;
let eventCount = 0;
let lastEvent = "";
let chatActive = false;
let currentRunId = "";

const pending = new Map();
function rpc(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ type: "req", id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("timeout"));
      }
    }, 15000);
  });
}

// --- Display ---

const CLEAR = "\x1b[2J\x1b[H";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";

function statusIcon(running) {
  return running ? `${GREEN}●${RESET}` : `${RED}○${RESET}`;
}
function timeAgo(ms) {
  if (!ms) {
    return "never";
  }
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) {
    return `${sec}s ago`;
  }
  if (sec < 3600) {
    return `${Math.floor(sec / 60)}m ago`;
  }
  return `${Math.floor(sec / 3600)}h ago`;
}

function renderDashboard() {
  if (eventsOnly) {
    return;
  }

  const lines = [];
  const now = new Date().toLocaleTimeString();

  if (compact) {
    const chSummary = Object.entries(channels)
      .map(([id, ch]) => `${id}:${ch.running ? "UP" : "DOWN"}`)
      .join(" ");
    const sessCount = sessions.length;
    const nodeCount = nodes.length;
    process.stdout.write(
      `\r${DIM}${now}${RESET} conn:${GREEN}${connId.substring(0, 8)}${RESET} ch:[${chSummary}] sess:${sessCount} nodes:${nodeCount} events:${eventCount} ${chatActive ? `${YELLOW}[chat]${RESET}` : ""} last:${lastEvent}    `,
    );
    return;
  }

  lines.push(CLEAR);
  lines.push(`${BOLD}╔══════════════════════════════════════════════════════════════╗${RESET}`);
  lines.push(`${BOLD}║              OPENCLAW GATEWAY MONITOR                       ║${RESET}`);
  lines.push(`${BOLD}╠══════════════════════════════════════════════════════════════╣${RESET}`);
  lines.push(
    `${BOLD}║${RESET} ${DIM}Time:${RESET} ${now}  ${DIM}Conn:${RESET} ${GREEN}${connId.substring(0, 12)}${RESET}  ${DIM}Events:${RESET} ${eventCount}  ${chatActive ? `${YELLOW}[CHAT ACTIVE]${RESET}` : `${DIM}idle${RESET}`}`,
  );
  lines.push(`${BOLD}╠══════════════════════════════════════════════════════════════╣${RESET}`);

  // Channels
  lines.push(`${BOLD}║ CHANNELS${RESET}`);
  if (Object.keys(channels).length === 0) {
    lines.push(`${BOLD}║${RESET}   ${DIM}(none)${RESET}`);
  }
  for (const [id, ch] of Object.entries(channels)) {
    const icon = statusIcon(ch.running);
    const mode = ch.mode ? ` (${ch.mode})` : "";
    const err = ch.lastError ? ` ${RED}${ch.lastError}${RESET}` : "";
    const inbound = ch.lastInboundAt ? ` in:${timeAgo(ch.lastInboundAt)}` : "";
    lines.push(
      `${BOLD}║${RESET}   ${icon} ${CYAN}${id}${RESET}${mode}${err}${DIM}${inbound}${RESET}`,
    );
  }
  lines.push(`${BOLD}╠══════════════════════════════════════════════════════════════╣${RESET}`);

  // Sessions
  lines.push(`${BOLD}║ SESSIONS${RESET} ${DIM}(${sessions.length})${RESET}`);
  for (const s of sessions.slice(0, 8)) {
    const name = s.displayName || s.key;
    const model = s.model ? ` ${DIM}${s.model}${RESET}` : "";
    const tokens = s.totalTokens ? ` ${DIM}${(s.totalTokens / 1000).toFixed(1)}k tok${RESET}` : "";
    const updated = s.updatedAt ? ` ${DIM}${timeAgo(s.updatedAt)}${RESET}` : "";
    lines.push(`${BOLD}║${RESET}   ${MAGENTA}${name}${RESET}${model}${tokens}${updated}`);
  }
  if (sessions.length > 8) {
    lines.push(`${BOLD}║${RESET}   ${DIM}... +${sessions.length - 8} more${RESET}`);
  }
  lines.push(`${BOLD}╠══════════════════════════════════════════════════════════════╣${RESET}`);

  // Nodes
  lines.push(`${BOLD}║ NODES${RESET} ${DIM}(${nodes.length})${RESET}`);
  for (const n of nodes) {
    const name = n.displayName || n.nodeId?.substring(0, 12);
    const caps = n.caps?.join(", ") || "";
    lines.push(
      `${BOLD}║${RESET}   ${GREEN}${name}${RESET} ${DIM}[${caps}]${RESET} ${DIM}${n.platform || ""}${RESET}`,
    );
  }
  lines.push(`${BOLD}╠══════════════════════════════════════════════════════════════╣${RESET}`);

  // Recent events
  lines.push(`${BOLD}║ LAST EVENT${RESET}`);
  lines.push(`${BOLD}║${RESET}   ${lastEvent || `${DIM}(waiting)${RESET}`}`);
  lines.push(`${BOLD}╚══════════════════════════════════════════════════════════════╝${RESET}`);
  lines.push(`${DIM}Press Ctrl+C to exit${RESET}`);

  process.stdout.write(lines.join("\n") + "\n");
}

// --- Connection ---

function connect() {
  const ws = new WebSocket(GATEWAY_URL);
  let authenticated = false;

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (msg.event === "connect.challenge") {
      const nonce = msg.payload.nonce;
      const signedAtMs = Date.now();
      const role = "operator";
      const scopes = ["operator.admin"];
      const platform = process.platform;
      const payload = [
        "v3",
        deviceId,
        "cli",
        "cli",
        role,
        scopes.join(","),
        String(signedAtMs),
        gatewayToken,
        nonce,
        platform.toLowerCase(),
        "",
      ].join("|");
      const signature = crypto
        .sign(null, Buffer.from(payload), { key: privateKeyPem, format: "pem" })
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
      ws.send(
        JSON.stringify({
          type: "req",
          id: crypto.randomUUID(),
          method: "connect",
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: { id: "cli", version: "dev", platform, mode: "cli" },
            role,
            scopes,
            auth: { token: gatewayToken },
            device: {
              id: deviceId,
              publicKey: pubKeyB64Url,
              signature,
              signedAt: signedAtMs,
              nonce,
            },
          },
        }),
      );
      return;
    }

    if (msg.type === "res") {
      if (!authenticated && msg.ok) {
        authenticated = true;
        connId = msg.payload?.server?.connId || "";
        _connectedAt = Date.now();
        void refresh(ws);
        return;
      }
      if (!authenticated && !msg.ok) {
        console.error("[FAIL]", msg.error?.code, msg.error?.message);
        ws.close();
        process.exit(1);
      }
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.ok) {
          p.resolve(msg.payload ?? msg);
        } else {
          p.reject(new Error(p.method + " failed"));
        }
      }
      return;
    }

    if (msg.type === "event") {
      eventCount++;
      handleEvent(msg, ws);
    }
  });

  ws.on("error", (e) => {
    if (!compact) {
      console.error("[ERR]", e.message);
    }
  });
  ws.on("close", () => {
    if (!compact) {
      console.error("[RECONNECT] in 3s...");
    }
    setTimeout(connect, 3000);
  });
}

async function refresh(ws) {
  try {
    const [chResult, sessResult, nodeResult] = await Promise.all([
      rpc(ws, "channels.status"),
      rpc(ws, "sessions.list"),
      rpc(ws, "node.list").catch(() => ({ nodes: [] })),
    ]);

    // Flatten channel accounts for display
    channels = {};
    if (chResult.channelAccounts) {
      for (const [chId, accounts] of Object.entries(chResult.channelAccounts)) {
        for (const acct of Array.isArray(accounts) ? accounts : Object.values(accounts)) {
          channels[chId + (acct.accountId !== "default" ? `:${acct.accountId}` : "")] = acct;
        }
      }
    } else if (chResult.channels) {
      channels = chResult.channels;
    }

    sessions = sessResult.sessions || [];
    nodes = nodeResult.nodes || [];

    renderDashboard();
  } catch (e) {
    if (!compact) {
      console.error("[ERR] refresh:", e.message);
    }
  }
}

function handleEvent(msg, ws) {
  const evt = msg.event;
  const p = msg.payload || {};

  // Agent events
  if (evt === "agent") {
    if (p.stream === "lifecycle" && p.data?.phase === "start") {
      chatActive = true;
      currentRunId = p.runId || "";
      lastEvent = `${YELLOW}chat started${RESET} ${DIM}${currentRunId?.substring(0, 8)}${RESET}`;
      if (eventsOnly) {
        console.log(
          `[${new Date().toLocaleTimeString()}] ${evt} lifecycle:start runId=${currentRunId?.substring(0, 8)}`,
        );
      }
      renderDashboard();
    } else if (p.stream === "assistant") {
      const text = p.data?.delta || p.data?.text || "";
      lastEvent = `${CYAN}assistant:${RESET} ${text.substring(0, 60)}`;
      if (eventsOnly) {
        process.stdout.write(text);
      }
      renderDashboard();
    } else if (p.stream === "lifecycle" && p.data?.phase === "end") {
      chatActive = false;
      lastEvent = `${GREEN}chat completed${RESET}`;
      if (eventsOnly) {
        console.log(`\n[${new Date().toLocaleTimeString()}] ${evt} lifecycle:end`);
      }
      renderDashboard();
    }
    return;
  }

  // Chat events
  if (evt === "chat") {
    return;
  } // handled via agent events

  // Health — do a full refresh instead of partial update
  if (evt === "health") {
    void refresh(ws);
    return;
  }

  // Device pairing
  if (evt === "device.pair.requested") {
    lastEvent = `${YELLOW}pairing request${RESET} ${p.deviceId?.substring(0, 12)} (${p.platform})`;
    if (eventsOnly) {
      console.log(
        `[${new Date().toLocaleTimeString()}] ${evt} device=${p.deviceId?.substring(0, 12)} platform=${p.platform}`,
      );
    }
    renderDashboard();
    return;
  }

  // Tick — periodic refresh
  if (evt === "tick") {
    void refresh(ws);
    return;
  }

  // Generic
  lastEvent = `${DIM}${evt}${RESET}`;
  if (eventsOnly) {
    console.log(`[${new Date().toLocaleTimeString()}] ${evt}`);
  }
  renderDashboard();
}

// --- Startup ---

process.on("SIGINT", () => {
  if (!compact) {
    process.stdout.write(CLEAR);
    console.log("Monitor stopped.");
  } else {
    console.log("");
  }
  process.exit(0);
});

connect();

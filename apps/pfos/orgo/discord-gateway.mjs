import WebSocket from "ws";

const DISCORD_TOKEN = String(process.env.DISCORD_BOT_TOKEN ?? "").trim();
const PF_MAIN_URL = String(process.env.PF_MAIN_URL ?? "http://127.0.0.1:18791").replace(/\/+$/, "");
const PF_API_TOKEN = String(process.env.PF_API_TOKEN ?? "").trim();
const DISCORD_ALLOWED_CHANNEL_IDS = String(process.env.DISCORD_ALLOWED_CHANNEL_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DISCORD_ALLOWED_GUILD_ID = String(process.env.DISCORD_ALLOWED_GUILD_ID ?? "").trim();
const PF_DISCORD_STRICT_ROUTING = String(process.env.PF_DISCORD_STRICT_ROUTING ?? "1") === "1";

if (!DISCORD_TOKEN) {
  console.error("DISCORD_BOT_TOKEN is required");
  process.exit(1);
}

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const INTENTS = 1 | 1 << 9 | 1 << 15; // GUILDS + GUILD_MESSAGES + MESSAGE_CONTENT

let ws;
let heartbeatTimer = null;
let lastSeq = null;
let sessionId = null;

function log(obj) {
  console.log(JSON.stringify({ ts: Date.now(), ...obj }));
}

async function discordApi(path, method = "GET", body = null) {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      authorization: `Bot ${DISCORD_TOKEN}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord API ${method} ${path} failed: ${res.status} ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

async function dispatchToMain(message) {
  const headers = { "content-type": "application/json" };
  if (PF_API_TOKEN) headers.authorization = `Bearer ${PF_API_TOKEN}`;
  const res = await fetch(`${PF_MAIN_URL}/discord/dispatch`, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `dispatch failed: ${res.status}`);
  }
  return data;
}

function shouldHandle(content) {
  const text = String(content ?? "").trim();
  if (!text) return false;
  if (PF_DISCORD_STRICT_ROUTING) {
    // Strict routing mode:
    // - explicit content/trading commands still work
    // - everything else is routed to main profile by /discord/dispatch
    return true;
  }
  return /^!agent\s+/i.test(text) || /^@pf-(main|content|trading)\b/i.test(text);
}

async function replyToChannel(channelId, content) {
  await discordApi(`/channels/${channelId}/messages`, "POST", { content });
}

function startHeartbeat(intervalMs) {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ op: 1, d: lastSeq }));
    }
  }, intervalMs);
}

function identify() {
  ws.send(
    JSON.stringify({
      op: 2,
      d: {
        token: DISCORD_TOKEN,
        intents: INTENTS,
        properties: {
          os: "linux",
          browser: "pf-orchestrator",
          device: "pf-orchestrator",
        },
      },
    })
  );
}

function resume() {
  ws.send(
    JSON.stringify({
      op: 6,
      d: {
        token: DISCORD_TOKEN,
        session_id: sessionId,
        seq: lastSeq,
      },
    })
  );
}

function connect() {
  ws = new WebSocket(GATEWAY_URL);

  ws.on("open", () => {
    log({ level: "info", msg: "discord gateway connected" });
  });

  ws.on("message", async (raw) => {
    const packet = JSON.parse(String(raw));
    if (packet.s !== null && packet.s !== undefined) lastSeq = packet.s;

    if (packet.op === 10) {
      startHeartbeat(packet.d.heartbeat_interval);
      if (sessionId && lastSeq !== null) {
        resume();
      } else {
        identify();
      }
      return;
    }

    if (packet.op === 7) {
      ws.close();
      return;
    }

    if (packet.t === "READY") {
      sessionId = packet.d.session_id;
      log({ level: "info", msg: "discord ready", user: packet.d.user?.username ?? "unknown" });
      log({ level: "info", msg: "routing mode", strictRouting: PF_DISCORD_STRICT_ROUTING });
      return;
    }

    if (packet.t !== "MESSAGE_CREATE") return;
    const evt = packet.d;
    if (!evt || evt.author?.bot) return;

    if (DISCORD_ALLOWED_GUILD_ID && String(evt.guild_id ?? "") !== DISCORD_ALLOWED_GUILD_ID) return;
    if (DISCORD_ALLOWED_CHANNEL_IDS.length > 0 && !DISCORD_ALLOWED_CHANNEL_IDS.includes(String(evt.channel_id))) return;
    if (!shouldHandle(evt.content)) return;

    try {
      const routed = await dispatchToMain({
        message: evt.content,
        author: evt.author?.username ?? evt.author?.id ?? "discord-user",
        channelId: evt.channel_id,
        messageId: evt.id,
      });

      await replyToChannel(
        evt.channel_id,
        `Routed to **${routed.profile}** as \`${routed.taskType}\` (task #${routed.taskId}, worker \`${routed.targetWorkerId}\`).`
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await replyToChannel(evt.channel_id, `Dispatch error: ${msg}`);
      log({ level: "error", msg: "dispatch failed", error: msg });
    }
  });

  ws.on("close", () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    log({ level: "warn", msg: "discord gateway closed, reconnecting" });
    setTimeout(connect, 2000);
  });

  ws.on("error", (error) => {
    log({ level: "error", msg: "discord gateway error", error: String(error) });
  });
}

connect();

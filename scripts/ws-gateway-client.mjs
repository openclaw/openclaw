#!/usr/bin/env node
import crypto from "crypto";
import fs from "fs";
import path from "path";
import readline from "readline";
/**
 * OpenClaw Gateway Client
 *
 * Authenticated WebSocket client for interacting with the OpenClaw gateway.
 * Supports RPC commands via CLI args or interactive stdin.
 *
 * Usage:
 *   node ws-gateway-client.mjs                          # interactive mode
 *   node ws-gateway-client.mjs --once                   # auth check only
 *   node ws-gateway-client.mjs chat.send "hello"        # send message
 *   node ws-gateway-client.mjs sessions.list            # list sessions
 *   node ws-gateway-client.mjs chat.history              # get chat history
 *   node ws-gateway-client.mjs channels.status           # channel status
 *   node ws-gateway-client.mjs config.get               # get full config
 *   echo '{"method":"chat.send","params":{"text":"hi"}}' | node ws-gateway-client.mjs --stdin
 *
 * Environment:
 *   OPENCLAW_GATEWAY_URL   ws://127.0.0.1:18789
 *   OPENCLAW_IDENTITY_FILE device.json path (overrides IDENTITY_DIR)
 *   OPENCLAW_IDENTITY_DIR  /home/node/.openclaw/identity
 *   OPENCLAW_CONFIG        /home/node/.openclaw/openclaw.json
 */
import WebSocket from "ws";

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789";
const IDENTITY_FILE = process.env.OPENCLAW_IDENTITY_FILE || "";
const IDENTITY_DIR = process.env.OPENCLAW_IDENTITY_DIR || "/home/node/.openclaw/identity";
const CONFIG_PATH = process.env.OPENCLAW_CONFIG || "/home/node/.openclaw/openclaw.json";

const args = process.argv.slice(2);
const flagOnce = args.includes("--once");
const flagStdin = args.includes("--stdin");
const flagQuiet = args.includes("-q") || args.includes("--quiet");
const positional = args.filter((a) => !a.startsWith("-"));

// --- Auth setup ---

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

// --- RPC helpers ---

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
    }, 30000);
  });
}

// --- Shorthand command parser ---

function parseCommand(parts) {
  const method = parts[0];
  if (!method) {
    return null;
  }

  switch (method) {
    // --- Chat ---
    case "chat.send":
      return {
        method,
        params: {
          sessionKey: parts[2] ? parts[1] : "agent:main:main",
          message: parts[2] ? parts.slice(2).join(" ") : parts.slice(1).join(" ") || "ping",
          idempotencyKey: crypto.randomUUID(),
        },
      };
    case "chat.history":
      return {
        method,
        params: {
          sessionKey: parts[2] ? parts[1] : "agent:main:main",
          limit: parseInt(parts[2] || parts[1]) || 20,
        },
      };
    case "chat.abort":
      return { method, params: { sessionKey: parts[1] || "agent:main:main" } };
    case "chat.inject":
      return {
        method,
        params: {
          sessionKey: parts[1] || "agent:main:main",
          role: parts[2] || "user",
          text: parts.slice(3).join(" ") || "",
        },
      };

    // --- Sessions ---
    case "sessions.list":
      return { method, params: {} };
    case "sessions.preview":
      return { method, params: { keys: [parts[1] || "agent:main:main"] } };
    case "sessions.delete":
      return { method, params: { key: parts[1] } };
    case "sessions.reset":
      return { method, params: { key: parts[1] } };
    case "sessions.compact":
      return { method, params: { key: parts[1] } };
    case "sessions.patch":
      return { method, params: { sessionKey: parts[1], ...JSON.parse(parts[2] || "{}") } };
    case "sessions.resolve":
      return { method, params: { sessionKey: parts[1] } };
    case "sessions.usage":
      return { method, params: {} };

    // --- Channels ---
    case "channels.status":
      return { method, params: {} };
    case "channels.logout":
      return { method, params: { channel: parts[1] } };

    // --- Agents ---
    case "agents.list":
      return { method, params: {} };
    case "agents.create":
      return {
        method,
        params: { name: parts[1], workspace: parts[1], ...JSON.parse(parts[2] || "{}") },
      };
    case "agents.update":
      return { method, params: { agentId: parts[1], ...JSON.parse(parts[2] || "{}") } };
    case "agents.delete":
      return { method, params: { agentId: parts[1] } };

    // --- Config ---
    case "config.get":
      return { method, params: {} };
    case "config.set":
      return { method, params: { raw: parts.slice(1).join(" ") } };
    case "config.patch":
      return { method, params: { raw: parts.slice(1).join(" ") } };
    case "config.apply":
      return { method, params: JSON.parse(parts[1] || "{}") };
    case "config.schema":
      return { method, params: {} };

    // --- Skills ---
    case "skills.status":
      return { method, params: {} };
    case "skills.install":
      return { method, params: { url: parts[1] } };
    case "skills.update":
      return { method, params: { id: parts[1] } };

    // --- Cron ---
    case "cron.list":
      return { method, params: {} };
    case "cron.add":
      return { method, params: JSON.parse(parts.slice(1).join(" ") || "{}") };
    case "cron.update":
      return { method, params: JSON.parse(parts.slice(1).join(" ") || "{}") };
    case "cron.remove":
      return { method, params: { id: parts[1] } };
    case "cron.run":
      return { method, params: { id: parts[1] } };
    case "cron.runs":
      return { method, params: { id: parts[1], limit: parseInt(parts[2]) || 10 } };

    // --- Tools ---
    case "tools.catalog":
      return { method, params: {} };

    // --- Devices ---
    case "device.pair.list":
      return { method, params: {} };
    case "device.pair.approve":
      return {
        method,
        params: {
          requestId: parts[1],
          role: "operator",
          scopes: [
            "operator.admin",
            "operator.read",
            "operator.write",
            "operator.approvals",
            "operator.pairing",
          ],
        },
      };
    case "device.pair.reject":
      return { method, params: { requestId: parts[1] } };
    case "device.pair.remove":
      return { method, params: { deviceId: parts[1] } };
    case "device.token.rotate":
      return { method, params: { deviceId: parts[1] } };
    case "device.token.revoke":
      return { method, params: { deviceId: parts[1], role: parts[2] || "operator" } };

    // --- Nodes ---
    case "node.list":
      return { method, params: {} };
    case "node.invoke":
      return {
        method,
        params: {
          nodeId: parts[1],
          command: parts[2],
          params: JSON.parse(parts[3] || "{}"),
          idempotencyKey: crypto.randomUUID(),
        },
      };
    case "node.describe":
      return { method, params: { nodeId: parts[1] } };
    case "node.rename":
      return { method, params: { nodeId: parts[1], name: parts[2] } };

    // --- Exec Approvals ---
    case "exec.approvals.get":
      return { method, params: {} };
    case "exec.approval.resolve":
      return { method, params: { requestId: parts[1], approved: parts[2] !== "deny" } };

    // --- Logs ---
    case "logs.tail":
      return { method, params: { lines: parseInt(parts[1]) || 50 } };

    // --- System ---
    case "gateway.reload":
      return { method, params: {} };
    case "update.run":
      return { method, params: {} };

    // --- TTS ---
    case "tts.status":
      return { method, params: {} };
    case "tts.providers":
      return { method, params: {} };

    // --- Wizard ---
    case "wizard.status":
      return { method, params: {} };
    case "wizard.start":
      return { method, params: { channel: parts[1] } };

    default:
      // Generic: treat remaining args as JSON params
      try {
        const params = parts[1] ? JSON.parse(parts.slice(1).join(" ")) : {};
        return { method, params };
      } catch {
        return { method, params: {} };
      }
  }
}

// --- Streaming support ---

const STREAMING_METHODS = new Set(["chat.send", "chat.inject"]);
let completionResolve = null;

// --- Connection ---

function connect() {
  const ws = new WebSocket(GATEWAY_URL);
  let authenticated = false;

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      if (!flagQuiet) {
        console.error("[WARN] malformed JSON frame");
      }
      return;
    }

    // --- Auth handshake ---
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

    // --- RPC response ---
    if (msg.type === "res") {
      if (!authenticated && msg.ok) {
        authenticated = true;
        if (!flagQuiet) {
          console.error("[OK] connected " + (msg.payload?.server?.connId || ""));
        }
        if (flagOnce) {
          ws.close();
          process.exit(0);
        }
        void afterAuth(ws);
        return;
      }
      if (!authenticated && !msg.ok) {
        console.error("[FAIL]", msg.error?.code, msg.error?.message);
        ws.close();
        process.exit(1);
      }
      // Resolve pending RPC
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.ok) {
          p.resolve(msg.payload ?? msg);
        } else {
          p.reject(new Error(`${p.method}: ${msg.error?.message || "error"}`));
        }
      }
      return;
    }

    // --- Events ---
    if (msg.type === "event") {
      if (msg.event === "tick" || msg.event === "health") {
        return;
      }

      // Agent stream: assistant text chunks
      if (msg.event === "agent" && msg.payload?.stream === "assistant") {
        process.stdout.write(msg.payload.data?.delta || msg.payload.data?.text || "");
        return;
      }
      // Agent lifecycle
      if (msg.event === "agent" && msg.payload?.stream === "lifecycle") {
        if (msg.payload?.data?.phase === "end") {
          process.stdout.write("\n");
          if (completionResolve) {
            completionResolve();
            completionResolve = null;
          }
        }
        return;
      }
      // Chat state events (suppress delta since agent stream handles text)
      if (msg.event === "chat") {
        if (msg.payload?.state === "final" && completionResolve) {
          completionResolve();
          completionResolve = null;
        }
        return;
      }
      // Legacy events
      if (msg.event === "chat.completion.chunk") {
        process.stdout.write(msg.payload?.text || msg.payload?.delta || "");
        return;
      }
      if (
        msg.event === "chat.completion" ||
        msg.event === "response.completed" ||
        msg.event === "response.failed"
      ) {
        if (completionResolve) {
          completionResolve();
          completionResolve = null;
        }
        return;
      }
      if (!flagQuiet) {
        console.error("[event]", msg.event);
      }
    }
  });

  ws.on("error", (e) => console.error("[ERR]", e.message));
  ws.on("close", (_code) => {
    if (!flagOnce && authenticated) {
      console.error("[RECONNECT] in 3s...");
      setTimeout(connect, 3000);
    } else if (!authenticated) {
      process.exit(1);
    }
  });
}

// --- Post-auth actions ---

async function afterAuth(ws) {
  // One-shot command from CLI args
  if (positional.length > 0) {
    const cmd = parseCommand(positional);
    if (cmd) {
      const isStreaming = STREAMING_METHODS.has(cmd.method);
      try {
        if (isStreaming) {
          const completionPromise = new Promise((resolve) => {
            completionResolve = resolve;
            setTimeout(resolve, 60000); // 60s timeout for streaming
          });
          const result = await rpc(ws, cmd.method, cmd.params);
          if (!flagQuiet) {
            console.error("[started] runId=" + (result.runId || ""));
          }
          await completionPromise;
        } else {
          const result = await rpc(ws, cmd.method, cmd.params);
          console.log(JSON.stringify(result, null, 2));
        }
      } catch (e) {
        console.error("[ERROR]", e.message);
      }
      ws.close();
      process.exit(0);
    }
  }

  // Piped stdin (JSON lines)
  if (flagStdin) {
    const rl = readline.createInterface({ input: process.stdin });
    for await (const line of rl) {
      try {
        const { method, params } = JSON.parse(line);
        const result = await rpc(ws, method, params);
        console.log(JSON.stringify(result));
      } catch (e) {
        console.error("[ERROR]", e.message);
      }
    }
    ws.close();
    process.exit(0);
  }

  // Interactive mode
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      prompt: "openclaw> ",
    });
    rl.prompt();
    rl.on("line", async (line) => {
      const parts = line.trim().split(/\s+/);
      if (!parts[0] || parts[0] === "exit" || parts[0] === "quit") {
        ws.close();
        process.exit(0);
      }
      if (parts[0] === "help") {
        console.error(
          "Chat:     chat.send <msg>, chat.send <key> <msg>, chat.history [key] [n], chat.abort [key], chat.inject <key> <role> <text>",
        );
        console.error(
          "Sessions: sessions.list, sessions.preview [key], sessions.delete <key>, sessions.reset <key>, sessions.compact <key>, sessions.usage",
        );
        console.error("Channels: channels.status, channels.logout <ch>");
        console.error(
          "Agents:   agents.list, agents.create <id> [json], agents.update <id> [json], agents.delete <id>",
        );
        console.error("Config:   config.get, config.set <raw>, config.patch <raw>, config.schema");
        console.error(
          "Cron:     cron.list, cron.add <json>, cron.remove <id>, cron.run <id>, cron.runs <id> [n]",
        );
        console.error(
          "Devices:  device.pair.list, device.pair.approve <reqId>, device.pair.reject <reqId>, device.pair.remove <devId>",
        );
        console.error(
          "Nodes:    node.list, node.describe <id>, node.invoke <id> <method> [json], node.rename <id> <name>",
        );
        console.error("Skills:   skills.status, skills.install <url>, skills.update <id>");
        console.error("Tools:    tools.catalog");
        console.error("Logs:     logs.tail [n]");
        console.error("System:   gateway.reload, update.run, tts.status, wizard.status");
        console.error("Generic:  <any.method> [json_params]");
        console.error("          exit / quit");
        rl.prompt();
        return;
      }
      const cmd = parseCommand(parts);
      if (cmd) {
        try {
          const result = await rpc(ws, cmd.method, cmd.params);
          console.log(JSON.stringify(result, null, 2));
        } catch (e) {
          console.error("[ERROR]", e.message);
        }
      }
      rl.prompt();
    });
  }
}

connect();

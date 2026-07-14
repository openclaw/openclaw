#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import WebSocket from "ws";

const DEFAULT_GATEWAY_PORT = process.env.OPENCLAW_GATEWAY_PORT || "18789";
const DEFAULT_GATEWAY_URL =
  process.env.OPENCLAW_GATEWAY_WS_URL || `ws://127.0.0.1:${DEFAULT_GATEWAY_PORT}`;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_WAIT_AFTER_SEND_MS = 30_000;
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function usage() {
  return `Usage: node scripts/durable-runtime-live-smoke.mjs [options]

Sends one Gateway chat.send request and records WebSocket evidence.

Options:
  --gateway <url>              Gateway WebSocket URL (default: OPENCLAW_GATEWAY_WS_URL or 127.0.0.1:${DEFAULT_GATEWAY_PORT})
  --session-key <key>          Session key to send to (required)
  --message <text>             Message text to send (required)
  --idempotency-key <key>      chat.send idempotency key (default: generated)
  --originating-channel <name> Originating channel label (default: durable-live-smoke)
  --originating-account-id <id> Originating account id (default: durable-live-smoke)
  --originating-to <target>    Originating target (default: durable-live-smoke)
  --origin <url>               Optional WebSocket Origin header
  --token-file <path>          Read Gateway shared token from a file (default: OPENCLAW_GATEWAY_TOKEN)
  --password-file <path>       Read Gateway shared password from a file (default: OPENCLAW_GATEWAY_PASSWORD)
  --timeout-ms <ms>            Request timeout (default: ${DEFAULT_TIMEOUT_MS})
  --wait-after-send-ms <ms>    Event collection window after chat.send (default: ${DEFAULT_WAIT_AFTER_SEND_MS})
  --help                       Show this help
`;
}

function readSecretFile(pathname, label) {
  const value = readFileSync(pathname, "utf8").trim();
  if (!value) {
    throw new Error(`${label} file is empty: ${pathname}`);
  }
  return value;
}

function trimSecret(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readRequiredArgValue(arg, value) {
  if (typeof value !== "string" || value.startsWith("--")) {
    throw new Error(`${arg} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const options = {
    gateway: DEFAULT_GATEWAY_URL,
    idempotencyKey: `durable-live-smoke-${randomUUID()}`,
    originatingChannel: "durable-live-smoke",
    originatingAccountId: "durable-live-smoke",
    originatingTo: "durable-live-smoke",
    token: trimSecret(process.env.OPENCLAW_GATEWAY_TOKEN),
    password: trimSecret(process.env.OPENCLAW_GATEWAY_PASSWORD),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    waitAfterSendMs: DEFAULT_WAIT_AFTER_SEND_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const next = argv[index + 1];
    switch (arg) {
      case "--gateway":
        options.gateway = readRequiredArgValue(arg, next);
        index += 1;
        break;
      case "--session-key":
        options.sessionKey = readRequiredArgValue(arg, next);
        index += 1;
        break;
      case "--message":
        options.message = readRequiredArgValue(arg, next);
        index += 1;
        break;
      case "--idempotency-key":
        options.idempotencyKey = readRequiredArgValue(arg, next);
        index += 1;
        break;
      case "--originating-channel":
        options.originatingChannel = readRequiredArgValue(arg, next);
        index += 1;
        break;
      case "--originating-account-id":
        options.originatingAccountId = readRequiredArgValue(arg, next);
        index += 1;
        break;
      case "--originating-to":
        options.originatingTo = readRequiredArgValue(arg, next);
        index += 1;
        break;
      case "--origin":
        options.origin = readRequiredArgValue(arg, next);
        index += 1;
        break;
      case "--token":
        throw new Error(
          "--token is intentionally unsupported; use OPENCLAW_GATEWAY_TOKEN or --token-file to avoid exposing secrets in process listings",
        );
      case "--token-file":
        options.token = readSecretFile(readRequiredArgValue(arg, next), "--token-file");
        index += 1;
        break;
      case "--password":
        throw new Error(
          "--password is intentionally unsupported; use OPENCLAW_GATEWAY_PASSWORD or --password-file to avoid exposing secrets in process listings",
        );
      case "--password-file":
        options.password = readSecretFile(readRequiredArgValue(arg, next), "--password-file");
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInteger(
          readRequiredArgValue(arg, next),
          DEFAULT_TIMEOUT_MS,
        );
        index += 1;
        break;
      case "--wait-after-send-ms":
        options.waitAfterSendMs = parsePositiveInteger(
          readRequiredArgValue(arg, next),
          DEFAULT_WAIT_AFTER_SEND_MS,
        );
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function connectAuth(options) {
  return {
    ...(options.token ? { token: options.token } : {}),
    ...(options.password ? { password: options.password } : {}),
  };
}

function authEvidence(options) {
  return {
    token: Boolean(options.token),
    password: Boolean(options.password),
  };
}

function compactPayload(payload) {
  const text = JSON.stringify(payload);
  if (text.length <= 1200) {
    return payload;
  }
  return {
    truncated: true,
    length: text.length,
    preview: text.slice(0, 1200),
  };
}

function decodeWebSocketData(data) {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  throw new Error("unsupported websocket message data type");
}

function responseRequestId(frame) {
  if (!frame || typeof frame !== "object" || typeof frame.id !== "string") {
    return undefined;
  }
  return REQUEST_ID_PATTERN.test(frame.id) ? frame.id : undefined;
}

function createClient(url, timeoutMs, origin) {
  const ws = new WebSocket(url, {
    handshakeTimeout: timeoutMs,
    ...(origin ? { headers: { Origin: origin } } : {}),
  });
  const pending = new Map();
  const events = [];
  let openedAt = 0;
  let closedAt = 0;
  let closeCode;
  let closeReason = "";

  ws.on("open", () => {
    openedAt = Date.now();
  });

  ws.on("message", (data) => {
    const frame = JSON.parse(decodeWebSocketData(data));
    if (frame.type === "res") {
      const responseId = responseRequestId(frame);
      const resolver = responseId ? pending.get(responseId) : undefined;
      if (resolver) {
        pending.delete(responseId);
        resolver(frame);
      }
      return;
    }
    if (frame.type === "event") {
      events.push({
        event: frame.event,
        receivedAt: Date.now(),
        payload: compactPayload(frame.payload),
      });
    }
  });

  ws.on("close", (code, reason) => {
    closedAt = Date.now();
    closeCode = code;
    closeReason = reason.toString();
    for (const [id, resolver] of pending) {
      pending.delete(id);
      resolver({
        type: "res",
        id,
        ok: false,
        error: {
          code: "CONNECTION_CLOSED",
          message: `websocket closed before response code=${code} reason=${closeReason || "n/a"}`,
        },
      });
    }
  });

  function waitOpen() {
    if (ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`gateway websocket open timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      function cleanup() {
        clearTimeout(timer);
        ws.off("open", onOpen);
        ws.off("error", onError);
      }
      ws.on("open", onOpen);
      ws.on("error", onError);
    });
  }

  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, (frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
      ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  function close() {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }

  return {
    waitOpen,
    request,
    close,
    getEvidence() {
      return {
        openedAt,
        closedAt: closedAt || undefined,
        closeCode,
        closeReason: closeReason || undefined,
        events,
      };
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (!options.sessionKey || !options.message) {
    throw new Error("--session-key and --message are required");
  }

  const origin = options.origin;
  const client = createClient(options.gateway, options.timeoutMs, origin);
  const auth = connectAuth(options);
  await client.waitOpen();
  const connectResponse = await client.request("connect", {
    minProtocol: 1,
    maxProtocol: 999,
    client: {
      id: "gateway-client",
      displayName: "durable runtime live smoke",
      version: "dev",
      platform: process.platform,
      mode: "backend",
    },
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
    caps: [],
    auth,
  });
  if (!connectResponse.ok) {
    client.close();
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          gateway: options.gateway,
          origin,
          auth: authEvidence(options),
          sessionKey: options.sessionKey,
          idempotencyKey: options.idempotencyKey,
          connect: {
            ok: false,
            error: connectResponse.error,
          },
          evidence: client.getEvidence(),
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const chatResponse = await client.request("chat.send", {
    sessionKey: options.sessionKey,
    message: options.message,
    idempotencyKey: options.idempotencyKey,
    originatingChannel: options.originatingChannel,
    originatingTo: options.originatingTo,
    originatingAccountId: options.originatingAccountId,
  });

  await new Promise((resolve) => {
    setTimeout(resolve, options.waitAfterSendMs);
  });
  client.close();

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: Boolean(connectResponse.ok && chatResponse.ok),
        gateway: options.gateway,
        origin,
        auth: authEvidence(options),
        sessionKey: options.sessionKey,
        idempotencyKey: options.idempotencyKey,
        connect: {
          ok: Boolean(connectResponse.ok),
          error: connectResponse.error,
        },
        chatSend: {
          ok: Boolean(chatResponse.ok),
          error: chatResponse.error,
          payload: compactPayload(chatResponse.payload),
        },
        evidence: client.getEvidence(),
      },
      null,
      2,
    )}\n`,
  );
}

try {
  await main();
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exitCode = 1;
}

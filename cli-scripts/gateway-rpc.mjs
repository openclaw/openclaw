#!/usr/bin/env node
/**
 * OpenClaw Gateway JSON-RPC client for CLI agents.
 * Uses Node.js native WebSocket (v22+), no external dependencies.
 *
 * Usage:
 *   node gateway-rpc.mjs <method> [paramsJSON]
 *
 * Examples:
 *   node gateway-rpc.mjs sessions.list
 *   node gateway-rpc.mjs chat.history '{"sessionKey":"agent:cto:main","limit":10}'
 *   node gateway-rpc.mjs chat.send '{"sessionKey":"agent:developer:main","message":"Hello!"}'
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Load config
const configPath = join(process.env.HOME || process.env.USERPROFILE, ".openclaw", "openclaw.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const port = config.gateway?.port ?? 18789;
const token = config.gateway?.auth?.token ?? "";

const method = process.argv[2];
if (!method) {
  console.error("Usage: node gateway-rpc.mjs <method> [paramsJSON]");
  process.exit(1);
}

let params = {};
if (process.argv[3]) {
  try {
    params = JSON.parse(process.argv[3]);
  } catch {
    console.error("Invalid JSON params:", process.argv[3]);
    process.exit(1);
  }
}

const isChatSend = method === "chat.send";
const isAgentMethod = method === "agent";

// Add idempotencyKey for methods that need it
if ((isAgentMethod || isChatSend) && !params.idempotencyKey) {
  params.idempotencyKey = randomUUID();
}

const connectId = randomUUID();
const requestId = randomUUID();

const ws = new WebSocket(`ws://127.0.0.1:${port}`);

const needsAsyncWait = isAgentMethod || isChatSend;
const timeoutMs = needsAsyncWait ? 180000 : 60000;

let chatSendRunId = null;

const timer = setTimeout(() => {
  console.error("Timeout waiting for response");
  ws.close();
  process.exit(1);
}, timeoutMs);

ws.addEventListener("open", () => {
  ws.send(
    JSON.stringify({
      type: "req",
      id: connectId,
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "cli",
          displayName: "gateway-rpc",
          version: "1.0",
          platform: process.platform,
          mode: "cli",
        },
        caps: [],
        auth: { token },
      },
    }),
  );
});

ws.addEventListener("message", (event) => {
  const frame = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());

  // Handle connect response
  if (frame.type === "res" && frame.id === connectId) {
    if (!frame.ok) {
      console.error("Connect failed:", JSON.stringify(frame.error));
      ws.close();
      process.exit(1);
    }
    // Send the actual RPC request
    ws.send(
      JSON.stringify({
        type: "req",
        id: requestId,
        method,
        params,
      }),
    );
    return;
  }

  // Handle RPC response
  if (frame.type === "res" && frame.id === requestId) {
    // agent: skip first "accepted" response, wait for final
    if (isAgentMethod && frame.ok && frame.payload?.status === "accepted") {
      return;
    }

    // chat.send: save runId from "started", then wait for chat evt
    if (isChatSend && frame.ok && frame.payload?.status === "started") {
      chatSendRunId = frame.payload.runId;
      return;
    }

    clearTimeout(timer);
    if (frame.ok) {
      console.log(JSON.stringify(frame.payload, null, 2));
    } else {
      console.error("Error:", JSON.stringify(frame.error, null, 2));
      ws.close();
      process.exit(1);
    }
    ws.close();
    return;
  }

  // Handle chat events (for chat.send: wait for final response)
  if (isChatSend && chatSendRunId && frame.type === "event" && frame.event === "chat") {
    const p = frame.payload;
    if (p?.runId !== chatSendRunId) {
      return;
    }

    if (p.state === "final") {
      clearTimeout(timer);
      const text =
        p.message?.content
          ?.filter((c) => c.type === "text")
          ?.map((c) => c.text)
          ?.join("\n") ?? "";
      console.log(text);
      ws.close();
      return;
    }

    if (p.state === "error") {
      clearTimeout(timer);
      console.error("Agent error:", p.errorMessage ?? "unknown error");
      ws.close();
      process.exit(1);
    }
  }
});

ws.addEventListener("error", (event) => {
  console.error("WebSocket error:", event.message || "connection failed");
  process.exit(1);
});

ws.addEventListener("close", () => {
  clearTimeout(timer);
});

import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { connectParams } from "./backchannel-settings.mjs";

export async function callGateway(settings, method, params) {
  const ws = new WebSocket(settings.gatewayUrl, { maxPayload: settings.maxPayloadBytes });
  const pending = new Map();
  let connectNonce = "";

  const cleanup = () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Gateway connection closed."));
    }
    pending.clear();
    try {
      ws.close();
    } catch {
      // Ignore close races.
    }
  };

  const request = (requestMethod, requestParams) =>
    new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Gateway request timeout for ${requestMethod}.`));
      }, settings.requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ type: "req", id, method: requestMethod, params: requestParams }));
    });

  ws.on("message", (data) => {
    let parsed;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      return;
    }
    if (parsed?.type === "evt" && parsed.event === "connect.challenge") {
      connectNonce =
        parsed.payload && typeof parsed.payload.nonce === "string" ? parsed.payload.nonce : "";
      return;
    }
    if (parsed?.type !== "res" || typeof parsed.id !== "string") {
      return;
    }
    const entry = pending.get(parsed.id);
    if (!entry) {
      return;
    }
    pending.delete(parsed.id);
    clearTimeout(entry.timer);
    if (parsed.ok) {
      entry.resolve(parsed.payload);
    } else {
      const message = parsed.error?.message || "Gateway request failed.";
      const error = new Error(message);
      error.details = parsed.error;
      entry.reject(error);
    }
  });

  try {
    await waitForSocketOpen(ws, settings.requestTimeoutMs);
    const challengeDeadline = Date.now() + settings.requestTimeoutMs;
    while (!connectNonce && Date.now() < challengeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!connectNonce) {
      throw new Error("Gateway connect challenge was not received.");
    }
    await request("connect", connectParams(settings, method));
    return await request(method, params);
  } finally {
    cleanup();
  }
}

function waitForSocketOpen(ws, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Gateway WebSocket open timeout."));
    }, timeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

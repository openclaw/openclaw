import type { NovaInboundMessage } from "./types.js";

/**
 * Parse an incoming WebSocket message from the API GW Lambda.
 * Returns a typed message on success, or `null` for malformed/unrecognized frames.
 */
export function parseNovaInboundMessage(raw: string): NovaInboundMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.action !== "message") {
    return null;
  }

  const userId = typeof obj.userId === "string" ? obj.userId.trim() : "";
  const text = typeof obj.text === "string" ? obj.text : "";
  const messageId = typeof obj.messageId === "string" ? obj.messageId.trim() : "";
  const timestamp = typeof obj.timestamp === "number" ? obj.timestamp : Date.now();

  if (!userId || !messageId) {
    return null;
  }

  return { action: "message", userId, text, messageId, timestamp };
}

import WebSocket from "ws";
import type { NovaConfig } from "./types.js";
import { getActiveNovaConnection } from "./connection.js";
import { resolveNovaCredentials } from "./credentials.js";

export type SendNovaMessageOpts = {
  cfg: { channels?: { nova?: NovaConfig } };
  to: string;
  text: string;
  replyTo?: string;
  done?: boolean;
};

export type SendNovaMessageResult = {
  messageId: string;
  conversationId: string;
};

/**
 * Send a response frame to the Nova backend via the active WebSocket connection.
 * `to` is the Nova userId, `replyTo` is the inbound messageId being replied to.
 */
export function sendNovaMessage(opts: SendNovaMessageOpts): SendNovaMessageResult {
  const ws = getActiveNovaConnection();
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("Nova WebSocket connection is not open");
  }

  const creds = resolveNovaCredentials(opts.cfg.channels?.nova);
  if (!creds) {
    throw new Error("Nova credentials not configured");
  }

  const messageId = crypto.randomUUID();
  const frame = JSON.stringify({
    action: "response",
    type: opts.done !== false ? "done" : "chunk",
    text: opts.text,
    messageId,
    replyTo: opts.replyTo ?? "",
    to: opts.to,
  });

  ws.send(frame);

  return { messageId, conversationId: opts.to };
}

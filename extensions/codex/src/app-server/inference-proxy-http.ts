import type { IncomingHttpHeaders } from "node:http";
import type { Duplex } from "node:stream";
import { rejectWebSocketUpgrade } from "openclaw/plugin-sdk/websocket-runtime";

const OVERLOADED = "Codex inference relay is busy; retry on a fresh connection.";
export const OVERLOAD_HEADERS = { "content-type": "application/json", "retry-after": "1" };
export const OVERLOAD_BODY = JSON.stringify({
  type: "error",
  status: 503,
  // Native treats backend server_is_overloaded as terminal; local saturation must retry.
  error: { type: "server_error", code: "inference_relay_busy", message: OVERLOADED },
  headers: { "retry-after": "1" },
});
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export function rejectBusyUpgrade(socket: Duplex) {
  rejectWebSocketUpgrade(socket, {
    status: 503,
    headers: { "Retry-After": "1" },
    body: { contentType: "application/json", text: OVERLOAD_BODY },
  });
}

export function relayHeaders(input: IncomingHttpHeaders): Record<string, string> {
  const excluded = new Set(HOP_HEADERS);
  for (const token of (input.connection ?? "").split(",")) {
    excluded.add(token.trim().toLowerCase());
  }
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && !excluded.has(key.toLowerCase())) {
      output[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return output;
}

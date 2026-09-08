import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

// CardKit codes that retire this card's stream server-side: 200850 is returned
// when the card's streaming mode times out, 300309 for every request issued after
// streaming mode is closed. Neither can be recovered by retrying, so the session
// that owns the card must stop writing to it. Every other code stays retryable —
// 19001 sequence rejections, HTTP 429, and transport failures are all transient.
const FEISHU_TERMINAL_STREAM_CODES = new Set([200850, 300309]);

export function isFeishuTerminalStreamCode(code: unknown): boolean {
  return typeof code === "number" && FEISHU_TERMINAL_STREAM_CODES.has(code);
}

export function isFeishuTerminalStreamError(error: unknown): boolean {
  return isRecord(error) && isFeishuTerminalStreamCode(error.code);
}

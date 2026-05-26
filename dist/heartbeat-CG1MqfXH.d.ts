//#region src/auto-reply/heartbeat.d.ts
declare const HEARTBEAT_PROMPT = "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.";
declare const DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 300;
declare function resolveHeartbeatPrompt(raw?: string): string;
type StripHeartbeatMode = "heartbeat" | "message";
declare function stripHeartbeatToken(raw?: string, opts?: {
  mode?: StripHeartbeatMode;
  maxAckChars?: number;
}): {
  shouldSkip: boolean;
  text: string;
  didStrip: boolean;
};
//#endregion
export { stripHeartbeatToken as i, HEARTBEAT_PROMPT as n, resolveHeartbeatPrompt as r, DEFAULT_HEARTBEAT_ACK_MAX_CHARS as t };
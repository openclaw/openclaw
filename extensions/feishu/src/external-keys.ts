const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const MAX_EXTERNAL_KEY_LENGTH = 512;

export function normalizeFeishuExternalKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_EXTERNAL_KEY_LENGTH) {
    return undefined;
  }
  if (CONTROL_CHARS_RE.test(normalized)) {
    return undefined;
  }
  if (normalized.includes("/") || normalized.includes("\\") || normalized.includes("..")) {
    return undefined;
  }
  return normalized;
}

/**
 * Strip synthetic reaction suffix from message IDs.
 *
 * OpenClaw generates composite IDs like `om_xxx:reaction:THUMBSUP:uuid` for
 * reaction events (see monitor.account.ts).  When these IDs are later used
 * as replyToMessageId in Feishu API calls, the API returns 400 because only
 * the base `om_xxx` part is a valid open_message_id.
 *
 * Fixes #34528
 */
export function stripFeishuReactionSuffix(messageId: string): string {
  const idx = messageId.indexOf(":reaction:");
  return idx === -1 ? messageId : messageId.slice(0, idx);
}

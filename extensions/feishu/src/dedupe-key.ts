import type { FeishuMessageEvent } from "./event-types.js";

/**
 * Resolve a stable dedupe key for a Feishu inbound message event.
 *
 * Most events are uniquely identified by `message_id` alone. However, Feishu
 * has been observed reusing the same `message_id` across distinct audio
 * uploads (issue #75057). When that happens, keying dedupe purely on
 * `message_id` silently drops the second voice note before its content is
 * parsed.
 *
 * For audio events with a parsable `file_key`, fold that key into the dedupe
 * identity so each distinct upload is processed exactly once while same-id
 * repeats are still suppressed. Other message types are unaffected.
 */
export function resolveFeishuMessageDedupeKey(event: FeishuMessageEvent): string {
  const messageId = event.message.message_id;
  if (event.message.message_type !== "audio") {
    return messageId;
  }
  const fileKey = parseFeishuAudioFileKey(event.message.content);
  return fileKey ? `${messageId}:audio:${fileKey}` : messageId;
}

function parseFeishuAudioFileKey(content: string | undefined | null): string | undefined {
  if (!content) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(content) as { file_key?: unknown };
    const raw = parsed?.file_key;
    if (typeof raw !== "string") {
      return undefined;
    }
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Registry for active streaming sessions.
 * Allows the outbound adapter to embed media into an active streaming card
 * instead of sending separate messages.
 */

/** Appends content (text or markdown image syntax) to the active streaming card. */
export type StreamAppender = (content: string) => void;

const activeStreams = new Map<string, StreamAppender>();
// Alias keys mapping to primary chatId (e.g. P2P outbound target `ou_xxx` → `oc_xxx`).
const aliases = new Map<string, string>();

export function registerStreamAppender(
  chatId: string,
  appender: StreamAppender,
  aliasKeys?: string[],
): void {
  activeStreams.set(chatId, appender);
  for (const alias of aliasKeys ?? []) {
    if (alias && alias !== chatId) {
      aliases.set(alias, chatId);
    }
  }
}

export function unregisterStreamAppender(chatId: string): void {
  activeStreams.delete(chatId);
  for (const [alias, primary] of aliases) {
    if (primary === chatId) {
      aliases.delete(alias);
    }
  }
}

export function getStreamAppender(key: string): StreamAppender | undefined {
  return activeStreams.get(key) ?? activeStreams.get(aliases.get(key) ?? "");
}

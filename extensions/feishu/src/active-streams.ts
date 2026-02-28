/**
 * In-memory registry for active streaming sessions.
 *
 * During streaming, the reply-dispatcher registers an appender function keyed
 * by chatId. Other modules (e.g. the outbound adapter) can look up the
 * appender to inject content into the card instead of sending separate messages.
 *
 * Alias keys allow lookup by alternative IDs (e.g. the normalized outbound
 * target `ou_xxx` for P2P chats where chatId is `oc_xxx`).
 */

export type StreamAppender = (content: string) => void;

const activeStreams = new Map<string, StreamAppender>();
const aliases = new Map<string, string>();

export function registerStreamAppender(
  primaryKey: string,
  appender: StreamAppender,
  aliasKeys?: string[],
): void {
  activeStreams.set(primaryKey, appender);
  if (aliasKeys) {
    for (const alias of aliasKeys) {
      aliases.set(alias, primaryKey);
    }
  }
}

export function unregisterStreamAppender(primaryKey: string): void {
  activeStreams.delete(primaryKey);
  for (const [alias, target] of aliases) {
    if (target === primaryKey) {
      aliases.delete(alias);
    }
  }
}

export function getStreamAppender(key: string): StreamAppender | undefined {
  return activeStreams.get(key) ?? activeStreams.get(aliases.get(key) ?? "");
}

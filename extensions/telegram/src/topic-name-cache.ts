/**
 * Bounded in-memory cache mapping Telegram forum topics to their
 * human-readable names.
 *
 * Topic names are extracted from:
 *   1. `reply_to_message.forum_topic_created.name` on regular messages
 *      (yields the *creation-time* name — still useful as a seed).
 *   2. `forum_topic_created` / `forum_topic_edited` service messages
 *      (authoritative, captures renames immediately).
 *   3. `forum_topic_closed` / `forum_topic_reopened` lifecycle events.
 *
 * Entries are keyed by `${chatId}:${threadId}` and capped at
 * `MAX_ENTRIES` to prevent unbounded growth on long-running gateways.
 */

const MAX_ENTRIES = 2_048;

export type TopicEntry = {
  name: string;
  iconColor?: number;
  iconCustomEmojiId?: string;
  closed?: boolean;
  updatedAt: number;
};

const cache = new Map<string, TopicEntry>();

function cacheKey(chatId: number | string, threadId: number | string): string {
  return `${chatId}:${threadId}`;
}

function evictOldest(): void {
  if (cache.size <= MAX_ENTRIES) {return;}
  let oldestKey: string | undefined;
  let oldestTime = Infinity;
  for (const [key, entry] of cache) {
    if (entry.updatedAt < oldestTime) {
      oldestTime = entry.updatedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) {cache.delete(oldestKey);}
}

export function updateTopicName(
  chatId: number | string,
  threadId: number | string,
  patch: Partial<Omit<TopicEntry, "updatedAt">>,
): void {
  const key = cacheKey(chatId, threadId);
  const existing = cache.get(key);
  const merged: TopicEntry = {
    name: patch.name ?? existing?.name ?? "",
    iconColor: patch.iconColor ?? existing?.iconColor,
    iconCustomEmojiId: patch.iconCustomEmojiId ?? existing?.iconCustomEmojiId,
    closed: patch.closed ?? existing?.closed,
    updatedAt: Date.now(),
  };
  if (!merged.name) {return;}
  cache.set(key, merged);
  evictOldest();
}

export function getTopicName(
  chatId: number | string,
  threadId: number | string,
): string | undefined {
  const entry = cache.get(cacheKey(chatId, threadId));
  if (entry) {
    entry.updatedAt = Date.now();
  }
  return entry?.name;
}

export function getTopicEntry(
  chatId: number | string,
  threadId: number | string,
): TopicEntry | undefined {
  return cache.get(cacheKey(chatId, threadId));
}

/** Visible for testing. */
export function clearTopicNameCache(): void {
  cache.clear();
}

export function topicNameCacheSize(): number {
  return cache.size;
}

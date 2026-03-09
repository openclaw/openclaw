/**
 * In-memory cache for streaming card full text.
 *
 * When a streaming card closes, the complete text is stored here keyed by the
 * Feishu message ID.  The "Show full text" card-action button reads from this
 * cache to re-send the content as a plain message when the card rendering was
 * incomplete.
 *
 * The cache is intentionally volatile — gateway restarts clear it.  A future
 * iteration may read from session JSONL files for persistent access.
 */

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface CacheEntry {
  text: string;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

export function cacheStreamingText(messageId: string, text: string): void {
  cleanExpired();
  cache.set(messageId, { text, timestamp: Date.now() });
}

export function getStreamingText(messageId: string): string | undefined {
  const entry = cache.get(messageId);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(messageId);
    return undefined;
  }
  return entry.text;
}

function cleanExpired(): void {
  const now = Date.now();
  for (const [key, val] of cache) {
    if (now - val.timestamp > CACHE_TTL_MS) cache.delete(key);
  }
}

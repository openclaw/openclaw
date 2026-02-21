// Prevent duplicate processing when WebSocket reconnects or Feishu redelivers messages.
const DEDUP_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEDUP_MAX_SIZE = 1_000;
const DEDUP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // cleanup every 5 minutes
const processedMessageIds = new Map<string, number>(); // messageId -> timestamp
let lastCleanupTime = Date.now();

export function tryRecordMessage(messageId: string, accountId: string = "default"): boolean {
  const now = Date.now();
  // Combine account ID + message ID to prevent cross-bot deduplication collisions
  // when multiple bots receive the same message event in a group chat.
  const uniqueKey = `${accountId}:${messageId}`;

  // Throttled cleanup: evict expired entries at most once per interval.
  if (now - lastCleanupTime > DEDUP_CLEANUP_INTERVAL_MS) {
    for (const [key, ts] of processedMessageIds) {
      if (now - ts > DEDUP_TTL_MS) {
        processedMessageIds.delete(key);
      }
    }
    lastCleanupTime = now;
  }

  if (processedMessageIds.has(uniqueKey)) {
    return false;
  }

  // Evict oldest entries if cache is full.
  if (processedMessageIds.size >= DEDUP_MAX_SIZE) {
    const first = processedMessageIds.keys().next().value!;
    processedMessageIds.delete(first);
  }

  processedMessageIds.set(uniqueKey, now);
  return true;
}

// Prevent duplicate processing when WebSocket reconnects or Feishu redelivers messages.
const DEDUP_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEDUP_MAX_SIZE = 1_000;
const DEDUP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // cleanup every 5 minutes
const processedMessageIds = new Map<string, number>(); // messageId -> timestamp
let lastCleanupTime = Date.now();

export function tryRecordMessage(messageId: string): boolean {
  const now = Date.now();

  // Throttled cleanup: evict expired entries at most once per interval.
  if (now - lastCleanupTime > DEDUP_CLEANUP_INTERVAL_MS) {
    for (const [id, ts] of processedMessageIds) {
      if (now - ts > DEDUP_TTL_MS) {
        processedMessageIds.delete(id);
      }
    }
    lastCleanupTime = now;
  }

  if (processedMessageIds.has(messageId)) {
    return false;
  }

  // Evict oldest entries if cache is full.
  if (processedMessageIds.size >= DEDUP_MAX_SIZE) {
    const first = processedMessageIds.keys().next().value!;
    processedMessageIds.delete(first);
  }

  processedMessageIds.set(messageId, now);
  return true;
}

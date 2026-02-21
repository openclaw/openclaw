const DEDUP_TTL_MS = 30 * 60 * 1000;
const DEDUP_MAX_SIZE = 1_000;
const DEDUP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const processedMessageIds = new Map<string, number>();
let lastCleanupTime = Date.now();

export function tryRecordMessage(messageId: string, scope = "default"): boolean {
  const now = Date.now();
  const dedupKey = `${scope}:${messageId}`;

  if (now - lastCleanupTime > DEDUP_CLEANUP_INTERVAL_MS) {
    for (const [id, ts] of processedMessageIds) {
      if (now - ts > DEDUP_TTL_MS) {
        processedMessageIds.delete(id);
      }
    }
    lastCleanupTime = now;
  }

  if (processedMessageIds.has(dedupKey)) {
    return false;
  }

  if (processedMessageIds.size >= DEDUP_MAX_SIZE) {
    const first = processedMessageIds.keys().next().value!;
    processedMessageIds.delete(first);
  }

  processedMessageIds.set(dedupKey, now);
  return true;
}

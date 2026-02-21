// Prevent duplicate processing when WebSocket reconnects or Feishu redelivers messages.
import { tryRecordMessagePersistent } from "./dedup-store.js";
import type { ResolvedFeishuAccount } from "./types.js";

const DEDUP_MAX_SIZE = 1_000;
// Memory cache entry TTL so we re-check disk periodically and sense external writes (e.g. flush from elsewhere)
const MEMORY_CACHE_ENTRY_TTL_MS = 30 * 1000; // 30 seconds
// Namespace prefix: `${accountId}:${messageId}` to avoid cross-account collision when message_id overlaps
const processedMessageIds = new Map<string, number>();

/**
 * Dedup check with persistent storage, per account.
 * Survives OpenClaw restarts and handles WebSocket reconnects properly.
 * Uses both memory cache (fast path) and disk storage (persistent).
 */
export async function tryRecordMessageAsync(
  account: ResolvedFeishuAccount,
  messageId: string,
): Promise<boolean> {
  const accountId = account.accountId ?? "default";
  const cacheKey = `${accountId}:${messageId}`;
  const now = Date.now();

  // Fast path: memory cache (expire after TTL so we re-check disk and see external writes)
  const cachedAt = processedMessageIds.get(cacheKey);
  if (cachedAt !== undefined) {
    if (now - cachedAt <= MEMORY_CACHE_ENTRY_TTL_MS) {
      return false;
    }
    processedMessageIds.delete(cacheKey);
  }

  // Then check persistent store for this account
  const isNew = await tryRecordMessagePersistent(accountId, messageId);

  // Update memory cache so next check for this message skips disk (whether new or already processed)
  if (processedMessageIds.size >= DEDUP_MAX_SIZE) {
    const first = processedMessageIds.keys().next().value!;
    processedMessageIds.delete(first);
  }
  processedMessageIds.set(cacheKey, now);

  return isNew;
}

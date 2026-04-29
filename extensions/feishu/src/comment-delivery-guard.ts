/**
 * Process-local TTL guard for Feishu comment delivery deduplication.
 *
 * This only suppresses duplicate deliveries within the current Node.js process.
 * Single-instance deployments are covered by this in-memory map. If Feishu
 * comment handling ever runs across multiple replicas, cross-instance dedup
 * needs a distributed backend instead of this local guard.
 */
const COMMENT_DELIVERY_GUARD_TTL_MS = 10 * 60 * 1000;
const COMMENT_DELIVERY_GUARD_MAX_ENTRIES = 1000;
const COMMENT_DELIVERY_GUARD_TRIM_TO_ENTRIES = 900;

function normalizeCommentDeliveryGuardValue(value: string | number | undefined | null): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === "string" ? value.trim() : "";
}

function buildCommentDeliveryGuardKey(params: {
  accountId?: string | null;
  to?: string | null;
  threadId?: string | number | null;
}): string | null {
  const accountId = normalizeCommentDeliveryGuardValue(params.accountId);
  const to = normalizeCommentDeliveryGuardValue(params.to);
  const threadId = normalizeCommentDeliveryGuardValue(params.threadId) || "_";
  if (!accountId || !to) {
    return null;
  }
  return `${accountId}::${to}::${threadId}`;
}

const completedCommentConversationDeliveries = new Map<string, number>();

function pruneExpiredCommentConversationDeliveries(now: number): void {
  for (const [key, expiresAt] of completedCommentConversationDeliveries) {
    if (expiresAt > now) {
      continue;
    }
    completedCommentConversationDeliveries.delete(key);
  }
}

function enforceCommentConversationDeliveryCap(): void {
  if (completedCommentConversationDeliveries.size <= COMMENT_DELIVERY_GUARD_MAX_ENTRIES) {
    return;
  }

  const entriesByExpiry = [...completedCommentConversationDeliveries.entries()].toSorted(
    ([, leftExpiresAt], [, rightExpiresAt]) => leftExpiresAt - rightExpiresAt,
  );
  const entriesToDelete =
    completedCommentConversationDeliveries.size - COMMENT_DELIVERY_GUARD_TRIM_TO_ENTRIES;

  for (let index = 0; index < entriesToDelete; index += 1) {
    const next = entriesByExpiry[index];
    if (!next) {
      break;
    }
    completedCommentConversationDeliveries.delete(next[0]);
  }
}

export function recordFeishuCommentConversationDelivery(params: {
  accountId?: string | null;
  to?: string | null;
  threadId?: string | number | null;
}): void {
  const key = buildCommentDeliveryGuardKey(params);
  if (!key) {
    return;
  }
  const now = Date.now();
  pruneExpiredCommentConversationDeliveries(now);
  completedCommentConversationDeliveries.delete(key);
  completedCommentConversationDeliveries.set(key, now + COMMENT_DELIVERY_GUARD_TTL_MS);
  enforceCommentConversationDeliveryCap();
}

export function hasFeishuCommentConversationDelivery(params: {
  accountId?: string | null;
  to?: string | null;
  threadId?: string | number | null;
}): boolean {
  const key = buildCommentDeliveryGuardKey(params);
  if (!key) {
    return false;
  }
  const now = Date.now();
  pruneExpiredCommentConversationDeliveries(now);
  const expiresAt = completedCommentConversationDeliveries.get(key);
  if (!expiresAt) {
    return false;
  }
  if (expiresAt <= now) {
    completedCommentConversationDeliveries.delete(key);
    return false;
  }
  return true;
}

export function clearFeishuCommentConversationDelivery(params: {
  accountId?: string | null;
  to?: string | null;
  threadId?: string | number | null;
}): void {
  const key = buildCommentDeliveryGuardKey(params);
  if (!key) {
    return;
  }
  completedCommentConversationDeliveries.delete(key);
}

export function resetFeishuCommentConversationDeliveriesForTest(): void {
  completedCommentConversationDeliveries.clear();
}

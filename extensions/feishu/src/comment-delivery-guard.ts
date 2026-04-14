const COMMENT_DELIVERY_GUARD_DEFAULT_ACCOUNT_ID = "default";

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
  const accountId =
    normalizeCommentDeliveryGuardValue(params.accountId) ||
    COMMENT_DELIVERY_GUARD_DEFAULT_ACCOUNT_ID;
  const to = normalizeCommentDeliveryGuardValue(params.to);
  const threadId = normalizeCommentDeliveryGuardValue(params.threadId) || "_";
  if (!to) {
    return null;
  }
  return `${accountId}::${to}::${threadId}`;
}

const completedCommentConversationDeliveries = new Set<string>();

export function recordFeishuCommentConversationDelivery(params: {
  accountId?: string | null;
  to?: string | null;
  threadId?: string | number | null;
}): void {
  const key = buildCommentDeliveryGuardKey(params);
  if (!key) {
    return;
  }
  completedCommentConversationDeliveries.add(key);
}

export function hasFeishuCommentConversationDelivery(params: {
  accountId?: string | null;
  to?: string | null;
  threadId?: string | number | null;
}): boolean {
  const key = buildCommentDeliveryGuardKey(params);
  return key ? completedCommentConversationDeliveries.has(key) : false;
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

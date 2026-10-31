/**
 * Feishu message IDs are `om_...`. Internal run/event IDs (UUIDs) are not valid
 * reply anchors, and the reply API rejects them with 99992354.
 */
export function normalizeFeishuNativeMessageId(
  value: string | number | null | undefined,
): string | undefined {
  if (value == null) {
    return undefined;
  }
  const id = typeof value === "number" ? String(value) : value.trim();
  return id.startsWith("om_") ? id : undefined;
}

export function resolveFeishuReplyTransport({
  replyToId,
  threadId,
}: {
  replyToId?: string | null;
  threadId?: string | number | null;
}) {
  return {
    // Drop synthetic anchors (e.g. exec/session-event UUIDs) instead of
    // forwarding them to /im/v1/messages/<id>/reply. Native om_ targets
    // and topic/thread routing stay intact.
    replyToId: normalizeFeishuNativeMessageId(replyToId) ?? null,
    threadId: threadId ?? null,
  };
}

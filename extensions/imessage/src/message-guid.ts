/** Strip the `p:<n>/` part prefix Messages puts on some GUIDs so keys match. */
export function normalizeIMessageGuid(value: string): string {
  return value.trim().replace(/^p:\d+\//iu, "");
}

/** Bridge status placeholders are not identities for receipts or echo matching. */
export function normalizeIMessageMessageId(value: string | null | undefined): string | undefined {
  const id = value?.trim();
  return id && id !== "ok" && id !== "unknown" ? id : undefined;
}

export function resolveIMessageSendResultId(
  result: Record<string, unknown> | null | undefined,
): string | null {
  if (!result) {
    return null;
  }
  const raw =
    (typeof result.messageGuid === "string" && result.messageGuid.trim()) ||
    (typeof result.messageId === "string" && result.messageId.trim()) ||
    (typeof result.message_id === "string" && result.message_id.trim()) ||
    (typeof result.id === "string" && result.id.trim()) ||
    (typeof result.guid === "string" && result.guid.trim()) ||
    (typeof result.message_id === "number" ? String(result.message_id) : null) ||
    (typeof result.id === "number" ? String(result.id) : null);
  return raw ? raw.trim() : null;
}

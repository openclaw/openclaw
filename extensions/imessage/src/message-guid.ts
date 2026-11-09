/** Strip the `p:<n>/` part prefix Messages puts on some GUIDs so keys match. */
export function normalizeIMessageGuid(value: string): string {
  return value.trim().replace(/^p:\d+\//iu, "");
}

/** Bridge status placeholders are not identities for receipts or echo matching. */
export function normalizeIMessageMessageId(value: string | null | undefined): string | undefined {
  const id = value?.trim();
  return id && id !== "ok" && id !== "unknown" ? id : undefined;
}

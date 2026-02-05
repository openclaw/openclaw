export function normalizeZulipBaseUrl(raw?: string | null): string | undefined {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "");
}

export function normalizeStreamName(raw?: string | null): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/^#/, "");
}

export function normalizeTopic(raw?: string | null): string {
  const value = (raw ?? "").trim();
  return value;
}

export function normalizeEmojiName(raw?: string | null): string {
  const value = (raw ?? "").trim();
  if (!value) {
    return "";
  }
  // Accept ":eyes:" style as well as "eyes".
  const stripped = value.replace(/^:/, "").replace(/:$/, "");
  return stripped.trim();
}

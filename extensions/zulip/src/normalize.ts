export function normalizeZulipMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("stream:")) {
    const rest = trimmed.slice("stream:".length).trim();
    return rest ? `stream:${rest}` : undefined;
  }
  if (lower.startsWith("user:") || lower.startsWith("dm:")) {
    const rest = trimmed.slice(trimmed.indexOf(":") + 1).trim();
    return rest ? `user:${rest}` : undefined;
  }
  if (lower.startsWith("zulip:")) {
    const rest = trimmed.slice("zulip:".length).trim();
    return rest ? `user:${rest}` : undefined;
  }
  if (trimmed.startsWith("@")) {
    const id = trimmed.slice(1).trim();
    return id ? `user:${id}` : undefined;
  }
  if (trimmed.startsWith("#")) {
    const id = trimmed.slice(1).trim();
    return id ? `stream:${id}` : undefined;
  }
  if (trimmed.includes("@")) {
    return `user:${trimmed}`;
  }
  return `stream:${trimmed}`;
}

export function looksLikeZulipTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (/^(user|dm|stream|zulip):/i.test(trimmed)) {
    return true;
  }
  if (/^[@#]/.test(trimmed)) {
    return true;
  }
  return trimmed.includes("@") || /^[a-z0-9][a-z0-9._-]{1,}$/i.test(trimmed);
}

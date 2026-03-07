/**
 * 钉钉目标 ID 标准化 / DingTalk target ID normalization
 */

function stripProviderPrefix(raw: string): string {
  return raw.replace(/^(dingtalk|dingding):/i, "").trim();
}

/**
 * Normalize DingTalk target ID, preserving explicit routing prefixes (user:/group:)
 * so that downstream outbound delivery can route correctly instead of guessing.
 */
export function normalizeDingtalkTarget(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withoutProvider = stripProviderPrefix(trimmed);
  const lowered = withoutProvider.toLowerCase();

  // Normalize user-like prefixes to "user:" and group-like to "group:"
  if (lowered.startsWith("user:") || lowered.startsWith("dm:") || lowered.startsWith("staff:")) {
    const colonIdx = withoutProvider.indexOf(":");
    const id = withoutProvider.slice(colonIdx + 1).trim();
    return id ? `user:${id}` : null;
  }
  if (lowered.startsWith("group:") || lowered.startsWith("chat:")) {
    const colonIdx = withoutProvider.indexOf(":");
    const id = withoutProvider.slice(colonIdx + 1).trim();
    return id ? `group:${id}` : null;
  }

  return withoutProvider;
}

/**
 * 判断是否像钉钉 ID / Check if string looks like a DingTalk ID
 */
export function looksLikeDingtalkId(raw: string): boolean {
  const trimmed = stripProviderPrefix(raw.trim());
  if (!trimmed) return false;

  // 带前缀的格式 / Prefixed format
  if (/^(user|dm|staff|group|chat):/i.test(trimmed)) return true;

  // cidXXXXXX 格式的 conversationId / conversationId in cidXXXXXX format
  if (/^cid[A-Za-z0-9+/=]+$/.test(trimmed)) return true;

  // Numeric staffId or alphanumeric staffId (e.g. manager1234)
  if (/^[A-Za-z0-9_]{3,}$/.test(trimmed)) return true;

  return false;
}

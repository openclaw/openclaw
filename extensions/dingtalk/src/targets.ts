/**
 * 钉钉目标 ID 标准化 / DingTalk target ID normalization
 */

function stripProviderPrefix(raw: string): string {
  return raw.replace(/^(dingtalk|dingding):/i, "").trim();
}

/**
 * 标准化钉钉目标 ID / Normalize DingTalk target ID
 */
export function normalizeDingtalkTarget(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withoutProvider = stripProviderPrefix(trimmed);
  const lowered = withoutProvider.toLowerCase();

  if (lowered.startsWith("user:")) {
    return withoutProvider.slice("user:".length).trim() || null;
  }
  if (lowered.startsWith("dm:")) {
    return withoutProvider.slice("dm:".length).trim() || null;
  }
  if (lowered.startsWith("staff:")) {
    return withoutProvider.slice("staff:".length).trim() || null;
  }
  if (lowered.startsWith("group:")) {
    return withoutProvider.slice("group:".length).trim() || null;
  }
  if (lowered.startsWith("chat:")) {
    return withoutProvider.slice("chat:".length).trim() || null;
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

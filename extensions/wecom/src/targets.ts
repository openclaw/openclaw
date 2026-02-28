export function normalizeWeComTarget(raw: string): string | null {
  if (!raw) return null;

  // Remove prefix if present
  const cleaned = raw.replace(/^(wecom|user):/i, "");

  // WeCom user IDs are typically alphanumeric
  if (/^[a-zA-Z0-9_-]+$/.test(cleaned)) {
    return cleaned;
  }

  return null;
}

export function looksLikeWeComId(raw: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(raw);
}

export function formatWeComTarget(userId: string): string {
  return `user:${userId}`;
}

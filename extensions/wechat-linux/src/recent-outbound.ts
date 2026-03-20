const RECENT_OUTBOUND_TTL_MS = 5 * 60 * 1000;
const recentOutboundByAccount = new Map<string, Map<number, number>>();

function prune(accountId: string, now: number): Map<number, number> {
  const current = recentOutboundByAccount.get(accountId) ?? new Map<number, number>();
  for (const [localId, expiresAt] of current.entries()) {
    if (expiresAt <= now) {
      current.delete(localId);
    }
  }
  if (current.size === 0) {
    recentOutboundByAccount.delete(accountId);
    return new Map<number, number>();
  }
  recentOutboundByAccount.set(accountId, current);
  return current;
}

export function noteRecentWechatLinuxOutbound(accountId: string, localId?: number | null) {
  if (!Number.isFinite(localId) || !localId) {
    return;
  }
  const now = Date.now();
  const current = prune(accountId, now);
  current.set(localId, now + RECENT_OUTBOUND_TTL_MS);
  recentOutboundByAccount.set(accountId, current);
}

export function isRecentWechatLinuxOutbound(accountId: string, localId?: number | null): boolean {
  if (!Number.isFinite(localId) || !localId) {
    return false;
  }
  const now = Date.now();
  return prune(accountId, now).has(localId);
}

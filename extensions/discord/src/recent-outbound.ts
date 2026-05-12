type RecentDiscordOutboundMessage = {
  accountId: string;
  channelId: string;
  messageId: string;
  at: number;
};

// Best-effort reconnect recovery anchor: intentionally in-memory and scoped to
// recent bot outbounds. This is not a persisted, general-purpose Discord history
// catch-up mechanism; it covers the common "user replied after OpenClaw spoke"
// gap when the Gateway socket silently misses events before reconnecting.
const RECENT_OUTBOUND_MAX = 500;
const RECENT_OUTBOUND_CHANNEL_WINDOW_MS = 15 * 60 * 1000;
const recentOutboundByKey = new Map<string, RecentDiscordOutboundMessage>();

function normalize(value: string | undefined | null): string {
  return value?.trim() ?? "";
}

function keyFor(accountId: string, channelId: string) {
  return `${accountId || "default"}:${channelId}`;
}

function trimRecentOutbound(now: number, maxAgeMs: number) {
  for (const [key, entry] of recentOutboundByKey) {
    if (now - entry.at > maxAgeMs) {
      recentOutboundByKey.delete(key);
    }
  }
  if (recentOutboundByKey.size <= RECENT_OUTBOUND_MAX) {
    return;
  }
  const sorted = [...recentOutboundByKey.entries()].toSorted((a, b) => a[1].at - b[1].at);
  for (const [key] of sorted.slice(0, recentOutboundByKey.size - RECENT_OUTBOUND_MAX)) {
    recentOutboundByKey.delete(key);
  }
}

export function recordRecentDiscordOutboundMessage(params: {
  accountId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  at?: number;
}) {
  const accountId = normalize(params.accountId) || "default";
  const channelId = normalize(params.channelId);
  const messageId = normalize(params.messageId);
  if (!channelId || !messageId) {
    return;
  }
  const at = params.at ?? Date.now();
  const key = keyFor(accountId, channelId);
  const existing = recentOutboundByKey.get(key);
  if (existing && at - existing.at <= RECENT_OUTBOUND_CHANNEL_WINDOW_MS) {
    trimRecentOutbound(at, 30 * 60 * 1000);
    return;
  }
  recentOutboundByKey.set(key, {
    accountId,
    channelId,
    messageId,
    at,
  });
  trimRecentOutbound(at, 30 * 60 * 1000);
}

export function listRecentDiscordOutboundMessages(params: {
  accountId?: string | null;
  maxAgeMs: number;
  now?: number;
}): RecentDiscordOutboundMessage[] {
  const accountId = normalize(params.accountId) || "default";
  const now = params.now ?? Date.now();
  trimRecentOutbound(now, params.maxAgeMs);
  return [...recentOutboundByKey.values()].filter(
    (entry) => entry.accountId === accountId && now - entry.at <= params.maxAgeMs,
  );
}

export function resetRecentDiscordOutboundMessagesForTest() {
  recentOutboundByKey.clear();
}

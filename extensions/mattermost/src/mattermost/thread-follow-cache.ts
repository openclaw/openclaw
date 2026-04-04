const MATTERMOST_THREAD_FOLLOW_CACHE_KEY = Symbol.for("openclaw.mattermostThreadFollow");
const MAX_THREAD_FOLLOW_ENTRIES = 5000;

type MattermostThreadFollowEntry = {
  lastBotReplyAt: number;
  lastSenderId: string;
};

function resolveThreadFollowCache(): Map<string, MattermostThreadFollowEntry> {
  const globalStore = globalThis as typeof globalThis & {
    [MATTERMOST_THREAD_FOLLOW_CACHE_KEY]?: Map<string, MattermostThreadFollowEntry>;
  };
  if (!globalStore[MATTERMOST_THREAD_FOLLOW_CACHE_KEY]) {
    globalStore[MATTERMOST_THREAD_FOLLOW_CACHE_KEY] = new Map<
      string,
      MattermostThreadFollowEntry
    >();
  }
  return globalStore[MATTERMOST_THREAD_FOLLOW_CACHE_KEY];
}

function buildThreadFollowKey(accountId: string, channelId: string, threadRootId: string): string {
  return `${accountId}:${channelId}:${threadRootId}`;
}

function pruneThreadFollowCache(now: number, maxAgeMs: number): void {
  const cache = resolveThreadFollowCache();
  const cutoff = now - Math.max(1, maxAgeMs);
  for (const [key, entry] of cache) {
    if (entry.lastBotReplyAt < cutoff) {
      cache.delete(key);
    }
  }
  while (cache.size > MAX_THREAD_FOLLOW_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    cache.delete(oldestKey);
  }
}

export function recordMattermostThreadFollow(params: {
  accountId: string;
  channelId: string;
  threadRootId: string;
  senderId: string;
  nowMs?: number;
  ttlMs: number;
}): void {
  const accountId = params.accountId.trim();
  const channelId = params.channelId.trim();
  const threadRootId = params.threadRootId.trim();
  const senderId = params.senderId.trim();
  if (!accountId || !channelId || !threadRootId || !senderId) {
    return;
  }
  const nowMs = params.nowMs ?? Date.now();
  const cache = resolveThreadFollowCache();
  const key = buildThreadFollowKey(accountId, channelId, threadRootId);
  cache.delete(key);
  cache.set(key, {
    lastBotReplyAt: nowMs,
    lastSenderId: senderId,
  });
  pruneThreadFollowCache(nowMs, params.ttlMs);
}

export function hasMattermostThreadFollow(params: {
  accountId: string;
  channelId: string;
  threadRootId: string;
  senderId: string;
  ttlMs: number;
  nowMs?: number;
}): boolean {
  const accountId = params.accountId.trim();
  const channelId = params.channelId.trim();
  const threadRootId = params.threadRootId.trim();
  const senderId = params.senderId.trim();
  if (!accountId || !channelId || !threadRootId || !senderId) {
    return false;
  }
  const nowMs = params.nowMs ?? Date.now();
  const ttlMs = Math.max(1, params.ttlMs);
  const key = buildThreadFollowKey(accountId, channelId, threadRootId);
  const entry = resolveThreadFollowCache().get(key);
  if (!entry) {
    return false;
  }
  if (nowMs - entry.lastBotReplyAt >= ttlMs) {
    resolveThreadFollowCache().delete(key);
    return false;
  }
  return entry.lastSenderId === senderId;
}

export function clearMattermostThreadFollowCache(): void {
  resolveThreadFollowCache().clear();
}

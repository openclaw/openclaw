const SIGNAL_MESSAGE_CACHE_MAX = 2000;
const SIGNAL_MESSAGE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export type SignalMessageCacheEntry = {
  body: string;
  sender?: string;
  timestamp: number;
  cachedAt: number;
};

const signalMessageCacheByTimestamp = new Map<string, SignalMessageCacheEntry>();

function normalizeKey(timestamp: string): string {
  return timestamp.trim();
}

function parseTimestamp(timestamp: string): number {
  const parsed = Number(timestamp);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return Date.now();
}

function evictExpiredEntries(): void {
  const cutoff = Date.now() - SIGNAL_MESSAGE_CACHE_TTL_MS;
  for (const [key, entry] of signalMessageCacheByTimestamp) {
    if (entry.cachedAt < cutoff) {
      signalMessageCacheByTimestamp.delete(key);
      continue;
    }
    break;
  }
}

function evictOverflowEntries(): void {
  while (signalMessageCacheByTimestamp.size > SIGNAL_MESSAGE_CACHE_MAX) {
    const oldest = signalMessageCacheByTimestamp.keys().next().value;
    if (!oldest) {
      break;
    }
    signalMessageCacheByTimestamp.delete(oldest);
  }
}

export function cacheSignalMessage(timestamp: string, body: string, sender?: string): void {
  const key = normalizeKey(timestamp);
  if (!key) {
    return;
  }

  evictExpiredEntries();

  const now = Date.now();
  signalMessageCacheByTimestamp.delete(key);
  signalMessageCacheByTimestamp.set(key, {
    body,
    sender: sender?.trim() || undefined,
    timestamp: parseTimestamp(key),
    cachedAt: now,
  });

  evictOverflowEntries();
}

export function lookupSignalMessage(timestamp: string): SignalMessageCacheEntry | undefined {
  const key = normalizeKey(timestamp);
  if (!key) {
    return undefined;
  }

  evictExpiredEntries();

  const entry = signalMessageCacheByTimestamp.get(key);
  if (!entry) {
    return undefined;
  }

  const cutoff = Date.now() - SIGNAL_MESSAGE_CACHE_TTL_MS;
  if (entry.cachedAt < cutoff) {
    signalMessageCacheByTimestamp.delete(key);
    return undefined;
  }

  return entry;
}

export function clearSignalMessageCacheForTest(): void {
  signalMessageCacheByTimestamp.clear();
}

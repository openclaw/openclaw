/**
 * Per-conversation rate limiter that detects rapid-fire identical echo
 * patterns and suppresses them before they amplify into queue overflow.
 */

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_HITS = 5;
const CLEANUP_INTERVAL_MS = 120_000;

type LoopRateLimiter = {
  /** Returns true if this conversation has exceeded the rate limit. */
  isRateLimited: (conversationKey: string) => boolean;
  /** Record an inbound message for a conversation. */
  record: (conversationKey: string) => void;
};

export function createLoopRateLimiter(opts?: {
  windowMs?: number;
  maxHits?: number;
}): LoopRateLimiter {
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const maxHits = opts?.maxHits ?? DEFAULT_MAX_HITS;
  const conversations = new Map<string, number[]>();
  let lastCleanup = Date.now();

  function cleanup() {
    const now = Date.now();
    if (now - lastCleanup < CLEANUP_INTERVAL_MS) {
      return;
    }
    lastCleanup = now;
    for (const [key, timestamps] of conversations.entries()) {
      const recent = timestamps.filter((ts) => now - ts <= windowMs);
      if (recent.length === 0) {
        conversations.delete(key);
      } else {
        conversations.set(key, recent);
      }
    }
  }

  return {
    record(conversationKey: string) {
      cleanup();
      let timestamps = conversations.get(conversationKey);
      if (!timestamps) {
        timestamps = [];
        conversations.set(conversationKey, timestamps);
      }
      timestamps.push(Date.now());
    },

    isRateLimited(conversationKey: string): boolean {
      cleanup();
      const timestamps = conversations.get(conversationKey);
      if (!timestamps) {
        return false;
      }
      const now = Date.now();
      const recent = timestamps.filter((ts) => now - ts <= windowMs);
      conversations.set(conversationKey, recent);
      return recent.length >= maxHits;
    },
  };
}

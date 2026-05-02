// In-memory nonce dedupe with TTL cleanup.
// We let entries live a little longer than the receipt freshness window so a
// late-arriving replay of a still-valid receipt is still rejected.

const seen = new Map<string, number>();
const TTL_MS = 6 * 60 * 1000;

const cleanup = (now: number): void => {
  for (const [nonce, ts] of seen) {
    if (now - ts > TTL_MS) seen.delete(nonce);
  }
};

export const noteNonce = (nonce: string): "fresh" | "replay" => {
  const now = Date.now();
  cleanup(now);
  if (seen.has(nonce)) return "replay";
  seen.set(nonce, now);
  return "fresh";
};

export const resetNonceStore = (): void => {
  seen.clear();
};

export const nonceStoreSize = (): number => seen.size;

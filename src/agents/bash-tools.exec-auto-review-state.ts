import { LruCache } from "../infra/lru-cache.js";

export const MAX_CONSECUTIVE_AUTO_REVIEW_DENIALS = 3;
const MAX_AUTO_REVIEW_SESSIONS = 256;
export const consecutiveAutoReviewDenials = new LruCache<number>(MAX_AUTO_REVIEW_SESSIONS);

export function recordAutoReviewDenial(sessionKey: string | undefined): number {
  if (!sessionKey) {
    return 1;
  }
  const count = Math.min(
    (consecutiveAutoReviewDenials.get(sessionKey) ?? 0) + 1,
    MAX_CONSECUTIVE_AUTO_REVIEW_DENIALS,
  );
  consecutiveAutoReviewDenials.set(sessionKey, count);
  return count;
}

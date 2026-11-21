// Consecutive auto-review denials per session. Once a session reaches the limit, a denial
// escalates instead of returning to the model for another reviewed attempt; any approved
// decision clears the streak.
import { LruCache } from "../infra/lru-cache.js";

const MAX_CONSECUTIVE_AUTO_REVIEW_DENIALS = 3;
const MAX_AUTO_REVIEW_SESSIONS = 256;
const consecutiveAutoReviewDenials = new LruCache<number>(MAX_AUTO_REVIEW_SESSIONS);

/** Records one auto-review denial and reports whether the session reached the limit. */
export function recordAutoReviewDenialReachesLimit(sessionKey: string | undefined): boolean {
  if (!sessionKey) {
    return false;
  }
  const count = Math.min(
    (consecutiveAutoReviewDenials.get(sessionKey) ?? 0) + 1,
    MAX_CONSECUTIVE_AUTO_REVIEW_DENIALS,
  );
  consecutiveAutoReviewDenials.set(sessionKey, count);
  return count >= MAX_CONSECUTIVE_AUTO_REVIEW_DENIALS;
}

/** Clears a session's denial streak after an approved decision. */
export function clearAutoReviewDenials(sessionKey: string | undefined): void {
  if (sessionKey) {
    consecutiveAutoReviewDenials.delete(sessionKey);
  }
}

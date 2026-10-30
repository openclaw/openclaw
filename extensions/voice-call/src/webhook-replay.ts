import { createDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";

const REPLAY_WINDOW_MS = 10 * 60 * 1000;
const REPLAY_CACHE_MAX_ENTRIES = 10_000;

type WebhookReplayCache = ReturnType<typeof createWebhookReplayCache>;

export function createWebhookReplayCache() {
  return createDedupeCache({ ttlMs: REPLAY_WINDOW_MS, maxSize: REPLAY_CACHE_MAX_ENTRIES });
}

export function reserveWebhookReplay(cache: WebhookReplayCache, replayKey: string) {
  const now = Date.now();
  if (asDateTimestampMs(now) !== undefined && cache.peek(replayKey, now)) {
    return { isReplay: true, verifiedRequestKey: replayKey };
  }

  const expiresAt = resolveExpiresAtMsFromDurationMs(REPLAY_WINDOW_MS, { nowMs: now });
  if (expiresAt === undefined) {
    return { isReplay: false, verifiedRequestKey: replayKey };
  }
  const reservation = {};
  cache.check(replayKey, now, reservation);
  return {
    isReplay: false,
    verifiedRequestKey: replayKey,
    // An older failed delivery must never clear a newer same-key reservation.
    releaseReplay: () => cache.delete(replayKey, reservation),
  };
}

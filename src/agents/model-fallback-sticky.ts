import { pruneMapToMaxSize } from "../infra/map-size.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import {
  MODEL_FALLBACK_SKIPPED_CODE,
  type FallbackAttempt,
  type ModelCandidate,
  type ModelFallbackCandidate,
} from "./model-fallback.types.js";
import { modelKey } from "./model-ref-shared.js";

const IDLE_WINDOW_MS = 10 * 60_000;
const HARD_CAP_MS = 30 * 60_000;
const MAX_STICKY_SESSIONS = 1024;
const log = createSubsystemLogger("model-fallback");

type StickyEntry = {
  requested: ModelCandidate;
  fallback: ModelCandidate;
  stuckAtMs: number;
  lastUsedAtMs: number;
};

type StickyRateLimitFallback = {
  candidates: ModelFallbackCandidate[];
  /** Seeds the run's attempts: a skipped selected model keeps the fallback reason visible. */
  attempts: FallbackAttempt[];
  record: (winner: ModelCandidate, attempts: readonly FallbackAttempt[]) => void;
};

// Process-global so duplicated module instances (bundle chunks, per-file test registries)
// share one store. Restart costs at most one cold cache; idle expiry and the cap bound
// primary deferral.
const stickyFallbacks = resolveGlobalMap<string, StickyEntry>(
  Symbol.for("openclaw.stickyRateLimitFallbacks"),
  "close-and-restart",
);

export function takeStickyRateLimitFallback(
  params: { sessionId?: string; stickyRateLimitFallback?: boolean },
  candidates: ModelFallbackCandidate[],
): StickyRateLimitFallback | undefined {
  const sessionId = params.sessionId;
  if (params.stickyRateLimitFallback !== true || !sessionId) {
    return undefined;
  }
  const entry = stickyFallbacks.get(sessionId);
  // Taking clears the preference unless a qualifying winner re-records it.
  // An aborted sticky run drops stickiness; its next turn tries the primary.
  stickyFallbacks.delete(sessionId);
  const requested = candidates.find((candidate) => candidate.routeOrigin === "requested");
  const requestedKey = requested ? modelKey(requested.provider, requested.model) : undefined;
  const now = Date.now();
  const stickyIndex =
    entry &&
    requestedKey === modelKey(entry.requested.provider, entry.requested.model) &&
    now - entry.lastUsedAtMs <= IDLE_WINDOW_MS &&
    now - entry.stuckAtMs <= HARD_CAP_MS
      ? candidates.findIndex(
          (candidate) =>
            modelKey(candidate.provider, candidate.model) ===
            modelKey(entry.fallback.provider, entry.fallback.model),
        )
      : -1;
  const stickyCandidate = stickyIndex > 0 ? candidates[stickyIndex] : undefined;
  let orderedCandidates = candidates;
  let skippedAttempt: FallbackAttempt | undefined;
  if (stickyCandidate && requested) {
    skippedAttempt = {
      provider: requested.provider,
      model: requested.model,
      error: `Trying ${modelKey(stickyCandidate.provider, stickyCandidate.model)} first after a recent rate limit in this session`,
      reason: "rate_limit",
      code: MODEL_FALLBACK_SKIPPED_CODE,
    };
    orderedCandidates = [
      stickyCandidate,
      ...candidates.slice(0, stickyIndex),
      ...candidates.slice(stickyIndex + 1),
    ];
    log.info(
      `Session ${sessionId}: trying sticky rate-limit fallback ${modelKey(stickyCandidate.provider, stickyCandidate.model)} before ${requestedKey}`,
    );
  }
  return {
    candidates: orderedCandidates,
    attempts: skippedAttempt ? [skippedAttempt] : [],
    record(winner, attempts) {
      const winnerKey = modelKey(winner.provider, winner.model);
      if (!requested || winnerKey === requestedKey) {
        return;
      }
      const reuseSticky =
        stickyCandidate && winnerKey === modelKey(stickyCandidate.provider, stickyCandidate.model);
      if (
        !reuseSticky &&
        !attempts.some(
          (attempt) =>
            attempt !== skippedAttempt &&
            attempt.reason === "rate_limit" &&
            modelKey(attempt.provider, attempt.model) === requestedKey,
        )
      ) {
        return;
      }
      const usedAtMs = Date.now();
      stickyFallbacks.delete(sessionId);
      stickyFallbacks.set(sessionId, {
        requested: { provider: requested.provider, model: requested.model },
        fallback: { provider: winner.provider, model: winner.model },
        stuckAtMs: reuseSticky && entry ? entry.stuckAtMs : usedAtMs,
        lastUsedAtMs: usedAtMs,
      });
      pruneMapToMaxSize(stickyFallbacks, MAX_STICKY_SESSIONS);
    },
  };
}

export function resetStickyRateLimitFallbacksForTest(): void {
  stickyFallbacks.clear();
}

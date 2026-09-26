import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { isActiveUnusableWindow } from "./auth-profiles/usage-state.js";
import { shouldUseTransientCooldownProbeSlot } from "./failover-policy.js";
import type { FailoverReason } from "./failover/signal.js";
import type { ModelFallbackAuthRuntime } from "./model-fallback-attempt.js";
import type { ModelCandidate } from "./model-fallback.types.js";

type CooldownAuthRuntime = Pick<
  ModelFallbackAuthRuntime,
  "getSoonestCooldownExpiry" | "resolveProfilesUnavailableReason"
>;

const lastProbeAttempt = new Map<string, number>();
const MIN_PROBE_INTERVAL_MS = 30_000;
const PROBE_MARGIN_MS = 2 * 60 * 1000;
const PROBE_SCOPE_DELIMITER = "::";
const PROBE_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PROBE_KEYS = 256;

export function resolveProbeThrottleKey(provider: string, agentDir?: string): string {
  const scope = normalizeOptionalString(agentDir) ?? "";
  return scope ? `${scope}${PROBE_SCOPE_DELIMITER}${provider}` : provider;
}

function pruneProbeState(now: number): void {
  for (const [key, ts] of lastProbeAttempt) {
    if (!Number.isFinite(ts) || ts <= 0 || now - ts > PROBE_STATE_TTL_MS) {
      lastProbeAttempt.delete(key);
    }
  }
}

function enforceProbeStateCap(): void {
  while (lastProbeAttempt.size > MAX_PROBE_KEYS) {
    let oldestKey: string | null = null;
    let oldestTs = Number.POSITIVE_INFINITY;
    for (const [key, ts] of lastProbeAttempt) {
      if (ts < oldestTs) {
        oldestKey = key;
        oldestTs = ts;
      }
    }
    if (!oldestKey) {
      break;
    }
    lastProbeAttempt.delete(oldestKey);
  }
}

function isProbeThrottleOpen(now: number, throttleKey: string): boolean {
  pruneProbeState(now);
  const lastProbe = lastProbeAttempt.get(throttleKey) ?? 0;
  return now - lastProbe >= MIN_PROBE_INTERVAL_MS;
}

export function markProbeAttempt(now: number, throttleKey: string): void {
  pruneProbeState(now);
  lastProbeAttempt.set(throttleKey, now);
  enforceProbeStateCap();
}

function hasActiveProviderRateLimitResetWindow(params: {
  authStore: AuthProfileStore;
  profileIds: string[];
  now: number;
  model: string;
}): boolean {
  return params.profileIds.some((profileId) => {
    const stats = params.authStore.usageStats?.[profileId];
    if (!stats || !isActiveUnusableWindow(stats.blockedUntil, params.now)) {
      return false;
    }
    if (stats.blockedReason !== "subscription_limit" || !stats.blockedSource) {
      return false;
    }
    return !stats.blockedModel || stats.blockedModel === params.model;
  });
}

function shouldProbePrimaryDuringCooldown(params: {
  isPrimary: boolean;
  hasFallbackCandidates: boolean;
  reason: FailoverReason | null | undefined;
  now: number;
  throttleKey: string;
  authRuntime: CooldownAuthRuntime;
  authStore: AuthProfileStore;
  profileIds: string[];
  model: string;
}): boolean {
  if (!params.isPrimary || !isProbeThrottleOpen(params.now, params.throttleKey)) {
    return false;
  }

  // Without fallbacks, probe on every open throttle slot: rolling caps can
  // recover before the provider's reported reset, which may be days away (#90702).
  if (!params.hasFallbackCandidates) {
    return true;
  }

  const soonest = params.authRuntime.getSoonestCooldownExpiry(params.authStore, params.profileIds, {
    now: params.now,
    forModel: params.model,
  });
  // Generic 429 backoff can become stale before its local cooldown expires.
  // Provider-recorded reset windows still remain authoritative until near expiry.
  if (params.reason === "rate_limit" && !hasActiveProviderRateLimitResetWindow(params)) {
    return true;
  }
  if (soonest === null || !Number.isFinite(soonest)) {
    return true;
  }
  return params.now >= soonest - PROBE_MARGIN_MS;
}

/** @internal – exposed for unit tests only */
export const probeThrottleInternals = {
  lastProbeAttempt,
  MIN_PROBE_INTERVAL_MS,
  PROBE_MARGIN_MS,
  PROBE_STATE_TTL_MS,
  MAX_PROBE_KEYS,
  resolveProbeThrottleKey,
  isProbeThrottleOpen,
  pruneProbeState,
  markProbeAttempt,
} as const;

type CooldownDecision =
  | { type: "skip"; reason: FailoverReason; error: string }
  | { type: "attempt"; reason: FailoverReason; markProbe: boolean }
  | { type: "suspend_session"; reason: FailoverReason };

export function resolveCooldownDecision(params: {
  candidate: ModelCandidate;
  isPrimary: boolean;
  requestedModel: boolean;
  hasFallbackCandidates: boolean;
  now: number;
  probeThrottleKey: string;
  authRuntime: CooldownAuthRuntime;
  authStore: AuthProfileStore;
  profileIds: string[];
}): CooldownDecision {
  const inferredReason =
    params.authRuntime.resolveProfilesUnavailableReason({
      store: params.authStore,
      profileIds: params.profileIds,
      now: params.now,
    }) ?? "unknown";
  const shouldProbe = shouldProbePrimaryDuringCooldown({
    isPrimary: params.isPrimary,
    hasFallbackCandidates: params.hasFallbackCandidates,
    reason: inferredReason,
    now: params.now,
    throttleKey: params.probeThrottleKey,
    authRuntime: params.authRuntime,
    authStore: params.authStore,
    profileIds: params.profileIds,
    model: params.candidate.model,
  });

  const isPersistentAuthIssue = inferredReason === "auth" || inferredReason === "auth_permanent";
  if (isPersistentAuthIssue) {
    return {
      type: "skip",
      reason: inferredReason,
      error: `Provider ${params.candidate.provider} has ${inferredReason} issue (skipping all models)`,
    };
  }

  // Billing can recover after a balance change; permit primary probes while
  // preserving the throttle and preference for available fallback candidates.
  const shouldAttemptDespiteCooldown =
    inferredReason === "billing"
      ? params.isPrimary && shouldProbe
      : (params.isPrimary && (!params.requestedModel || shouldProbe)) ||
        (!params.isPrimary && shouldUseTransientCooldownProbeSlot(inferredReason));
  if (!shouldAttemptDespiteCooldown) {
    return {
      type: "suspend_session",
      reason: inferredReason,
    };
  }
  return {
    type: "attempt",
    reason: inferredReason,
    markProbe: params.isPrimary && shouldProbe,
  };
}

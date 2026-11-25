import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { shouldUseTransientCooldownProbeSlot } from "./failover-policy.js";
import type { FailoverReason } from "./failover/signal.js";
import type { ModelFallbackAuthRuntime } from "./model-fallback-attempt.js";
import type { ModelCandidate } from "./model-fallback.types.js";

const lastProbeAttempt = new Map<string, number>();
const MIN_PROBE_INTERVAL_MS = 30_000;
const PROBE_MARGIN_MS = 2 * 60 * 1000;
const PROBE_SCOPE_DELIMITER = "::";
const MAX_PROBE_KEYS = 256;

export function resolveProbeThrottleKey(provider: string, agentDir?: string): string {
  const scope = normalizeOptionalString(agentDir) ?? "";
  return scope ? `${scope}${PROBE_SCOPE_DELIMITER}${provider}` : provider;
}

function isProbeThrottleOpen(now: number, throttleKey: string): boolean {
  const lastProbe = lastProbeAttempt.get(throttleKey) ?? 0;
  return now - lastProbe >= MIN_PROBE_INTERVAL_MS;
}

export function markProbeAttempt(now: number, throttleKey: string): void {
  lastProbeAttempt.delete(throttleKey);
  lastProbeAttempt.set(throttleKey, now);
  pruneMapToMaxSize(lastProbeAttempt, MAX_PROBE_KEYS);
}

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
  authRuntime: Pick<
    ModelFallbackAuthRuntime,
    "getSoonestCooldownExpiry" | "resolveProfilesUnavailableReason"
  >;
  authStore: AuthProfileStore;
  profileIds: string[];
}): CooldownDecision {
  const inferredReason =
    params.authRuntime.resolveProfilesUnavailableReason({
      store: params.authStore,
      profileIds: params.profileIds,
      now: params.now,
    }) ?? "unknown";
  let shouldProbe = params.isPrimary && isProbeThrottleOpen(params.now, params.probeThrottleKey);
  // Without fallbacks, probe on every open throttle slot: rolling caps can
  // recover before the provider's reported reset, which may be days away (#90702).
  if (shouldProbe && params.hasFallbackCandidates) {
    const soonest = params.authRuntime.getSoonestCooldownExpiry(
      params.authStore,
      params.profileIds,
      { now: params.now, forModel: params.candidate.model },
    );
    shouldProbe = soonest === null || params.now >= soonest - PROBE_MARGIN_MS;
  }

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

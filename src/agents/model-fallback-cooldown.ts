import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { emitFailoverEvent } from "../infra/diagnostic-events.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { resolveSubscriptionAuthModeForProfiles } from "./auth-profiles/profile-list.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  shouldAllowCooldownProbeForReason,
  shouldUseTransientCooldownProbeSlot,
} from "./failover-policy.js";
import type { FailoverReason } from "./failover/signal.js";
import { isAgentHarnessPreflightError } from "./harness/errors.js";
import type {
  ModelFallbackAuthRuntime,
  ModelFallbackRunOptions,
} from "./model-fallback-attempt.js";
import type { ModelFallbackDecisionParams } from "./model-fallback-observation.js";
import type { ModelFallbackCandidate, ModelCandidate } from "./model-fallback.types.js";

type ProbeAttempt = { at: number; token: symbol };

export type ProbeAttemptReservation = Readonly<{
  throttleKey: string;
  token: symbol;
}>;

const lastProbeAttempt = new Map<string, ProbeAttempt>();
const MIN_PROBE_INTERVAL_MS = 30_000;
const PROBE_MARGIN_MS = 2 * 60 * 1000;
const PROBE_SCOPE_DELIMITER = "::";
const MAX_PROBE_KEYS = 256;

export function resolveProbeThrottleKey(provider: string, agentDir?: string): string {
  const scope = normalizeOptionalString(agentDir) ?? "";
  return scope ? `${scope}${PROBE_SCOPE_DELIMITER}${provider}` : provider;
}

function isProbeThrottleOpen(now: number, throttleKey: string): boolean {
  const lastProbe = lastProbeAttempt.get(throttleKey)?.at ?? 0;
  return now - lastProbe >= MIN_PROBE_INTERVAL_MS;
}

export function markProbeAttempt(now: number, throttleKey: string): ProbeAttemptReservation {
  const token = Symbol("probe-attempt");
  lastProbeAttempt.delete(throttleKey);
  lastProbeAttempt.set(throttleKey, { at: now, token });
  pruneMapToMaxSize(lastProbeAttempt, MAX_PROBE_KEYS);
  return { throttleKey, token };
}

export function releaseProbeAttempt(reservation: ProbeAttemptReservation): void {
  if (lastProbeAttempt.get(reservation.throttleKey)?.token === reservation.token) {
    lastProbeAttempt.delete(reservation.throttleKey);
  }
}

export function isKnownPreDispatchProbeFailure(error: unknown): boolean {
  if (isAgentHarnessPreflightError(error)) {
    return true;
  }
  return (
    error instanceof Error &&
    error.name === "WorkerRunnerUnavailableError" &&
    (error as Error & { providerDispatchStarted?: unknown }).providerDispatchStarted === false
  );
}

export type CooldownProbeAttempt = {
  skipCandidate?: true;
  runOptions?: Pick<ModelFallbackRunOptions, "allowTransientCooldownProbe">;
  attemptedDuringCooldown: boolean;
  transientProbeProviderForAttempt: string | null;
  probeReservation?: ProbeAttemptReservation;
};

export async function prepareCooldownProbeAttempt(params: {
  candidate: ModelFallbackCandidate;
  isPrimary: boolean;
  requestedModel: boolean;
  hasFallbackCandidates: boolean;
  hasRemainingCandidate: boolean;
  authRuntime: ModelFallbackAuthRuntime;
  authStore: AuthProfileStore;
  candidateAuthProfileIds: string[];
  cooldownProbeUsedProviders: Set<string>;
  agentDir?: string;
  sessionId?: string;
  lane?: string;
  pushSkippedAttempt: (error: string, reason: FailoverReason, authMode?: string) => void;
  observeCandidateDecision: (
    decision: ModelFallbackDecisionParams["decision"],
    extra?: Partial<ModelFallbackDecisionParams>,
  ) => Promise<void>;
  onTerminalSessionSuspension: (reason: FailoverReason) => void;
}): Promise<CooldownProbeAttempt> {
  const state: CooldownProbeAttempt = {
    attemptedDuringCooldown: false,
    transientProbeProviderForAttempt: null,
  };
  const profileIds = params.candidateAuthProfileIds;
  const isAnyProfileAvailable = profileIds.some(
    (id) =>
      !params.authRuntime.isProfileInCooldown(
        params.authStore,
        id,
        undefined,
        params.candidate.model,
      ),
  );
  if (profileIds.length === 0 || isAnyProfileAvailable) {
    return state;
  }

  const now = Date.now();
  const probeThrottleKey = resolveProbeThrottleKey(params.candidate.provider, params.agentDir);
  const decision = resolveCooldownDecision({
    candidate: params.candidate,
    isPrimary: params.isPrimary,
    requestedModel: params.requestedModel,
    hasFallbackCandidates: params.hasFallbackCandidates,
    now,
    probeThrottleKey,
    authRuntime: params.authRuntime,
    authStore: params.authStore,
    profileIds,
  });
  const authMode =
    decision.reason === "billing" ||
    decision.reason === "auth" ||
    decision.reason === "auth_permanent" ||
    decision.reason === "session_expired"
      ? resolveSubscriptionAuthModeForProfiles({ store: params.authStore, profileIds })
      : undefined;

  if (decision.type !== "attempt") {
    const error =
      decision.type === "skip"
        ? decision.error
        : `Provider ${params.candidate.provider} is in cooldown`;
    params.pushSkippedAttempt(error, decision.reason, authMode);
    if (decision.type === "suspend_session" && params.sessionId) {
      emitFailoverEvent({
        sessionId: params.sessionId,
        lane: params.lane,
        fromProvider: params.candidate.provider,
        fromModel: params.candidate.model,
        reason: decision.reason,
        suspended: !params.hasRemainingCandidate,
      });
      if (!params.hasRemainingCandidate) {
        params.onTerminalSessionSuspension(decision.reason);
      }
    }
    await params.observeCandidateDecision("skip_candidate", {
      reason: decision.reason,
      error,
      profileCount: profileIds.length,
    });
    return { ...state, skipCandidate: true };
  }

  if (shouldAllowCooldownProbeForReason(decision.reason)) {
    const isTransientCooldownReason = shouldUseTransientCooldownProbeSlot(decision.reason);
    if (
      isTransientCooldownReason &&
      params.cooldownProbeUsedProviders.has(params.candidate.provider)
    ) {
      const error = `Provider ${params.candidate.provider} is in cooldown (check already attempted this run)`;
      params.pushSkippedAttempt(error, decision.reason, authMode);
      await params.observeCandidateDecision("skip_candidate", {
        reason: decision.reason,
        error,
        profileCount: profileIds.length,
      });
      return { ...state, skipCandidate: true };
    }
    state.runOptions = { allowTransientCooldownProbe: true };
    if (isTransientCooldownReason) {
      state.transientProbeProviderForAttempt = params.candidate.provider;
    }
  }

  if (decision.markProbe) {
    // Reserve with the cooldown decision before observers can yield to another turn.
    state.probeReservation = markProbeAttempt(now, probeThrottleKey);
  }
  state.attemptedDuringCooldown = true;
  try {
    await params.observeCandidateDecision("probe_cooldown_candidate", {
      reason: decision.reason,
      allowTransientCooldownProbe: state.runOptions?.allowTransientCooldownProbe,
      profileCount: profileIds.length,
    });
  } catch (error) {
    if (state.probeReservation) {
      releaseProbeAttempt(state.probeReservation);
    }
    throw error;
  }
  return state;
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

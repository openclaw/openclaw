import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
} from "@openclaw/normalization-core/number-coercion";
import type {
  AuthProfileCooldownClassification,
  AuthProfileCredential,
  AuthProfileFailureReason,
  ProfileUsageStats,
} from "./types.js";
import { computeNextProfileUsageStats, resolveUsageWindowUntil } from "./usage-failure-state.js";
import { isAuthCooldownBypassedForProvider, isBlockedWindowActiveForModel } from "./usage-state.js";

export type WhamCooldownProbeResult = {
  available?: true;
  cooldownMs: number;
  cooldownClassification?: AuthProfileCooldownClassification;
  blockedUntil?: number;
};

export function isSameWhamCredential(
  expected: AuthProfileCredential,
  current: AuthProfileCredential | undefined,
): boolean {
  return (
    expected.type === "oauth" &&
    current?.type === "oauth" &&
    normalizeProviderId(expected.provider) === normalizeProviderId(current.provider) &&
    expected.access === current.access &&
    expected.accountId === current.accountId
  );
}

export function resolveActiveWindowUntil(value: unknown, now: number): number {
  const timestampMs = asDateTimestampMs(value);
  return timestampMs !== undefined && timestampMs > now ? timestampMs : 0;
}

function applyWhamCooldownResult(params: {
  existing: ProfileUsageStats;
  computed: ProfileUsageStats;
  now: number;
  whamResult: WhamCooldownProbeResult;
}): ProfileUsageStats {
  const existingActiveCooldownUntil = resolveActiveWindowUntil(
    params.existing.cooldownUntil,
    params.now,
  );
  const existingActiveBlockedUntil = resolveActiveWindowUntil(
    params.existing.blockedUntil,
    params.now,
  );
  if (params.whamResult.blockedUntil) {
    return {
      ...params.computed,
      lastProbeAt: params.now,
      blockedUntil: Math.max(existingActiveBlockedUntil, params.whamResult.blockedUntil),
      blockedReason: "subscription_limit",
      blockedSource: "wham",
      blockedModel: undefined,
      blockedScope: undefined,
      cooldownUntil: undefined,
      cooldownReason: undefined,
      cooldownClassification: undefined,
      cooldownModel: undefined,
    };
  }
  const { cooldownClassification } = params.whamResult;
  if (
    !cooldownClassification &&
    !params.whamResult.available &&
    (params.computed.cooldownReason === "rate_limit" ||
      (params.computed.blockedReason === "subscription_limit" &&
        isBlockedWindowActiveForModel(params.computed, params.now)))
  ) {
    // A failed or incomplete probe supplied no authoritative retry deadline.
    // Keep the persisted local backoff instead of replacing it with a fixed delay.
    return {
      ...params.computed,
      lastProbeAt: params.now,
    };
  }
  return {
    ...params.computed,
    lastProbeAt: params.now,
    cooldownUntil: Math.max(
      existingActiveCooldownUntil,
      resolveUsageWindowUntil(params.now, params.whamResult.cooldownMs),
    ),
    cooldownReason: cooldownClassification
      ? cooldownClassification === "wham_token_expired"
        ? "auth"
        : "auth_permanent"
      : params.computed.cooldownReason,
    cooldownClassification,
    cooldownModel: cooldownClassification ? undefined : params.computed.cooldownModel,
  };
}

export function matchesWhamBlockGeneration(
  stats: ProfileUsageStats | undefined,
  generation: ProfileUsageStats | undefined,
): boolean {
  return (
    stats?.blockedUntil === generation?.blockedUntil &&
    stats?.blockedReason === generation?.blockedReason &&
    stats?.blockedSource === generation?.blockedSource &&
    stats?.blockedModel === generation?.blockedModel &&
    stats?.blockedScope === generation?.blockedScope &&
    stats?.lastProbeAt === generation?.lastProbeAt &&
    stats?.lastFailureAt === generation?.lastFailureAt &&
    stats?.failureCounts?.rate_limit === generation?.failureCounts?.rate_limit
  );
}

export function reconcileWhamBlock(
  stats: ProfileUsageStats,
  result: WhamCooldownProbeResult,
  now: number,
): ProfileUsageStats {
  return {
    ...stats,
    blockedUntil: result.blockedUntil,
    blockedReason: result.available ? undefined : "subscription_limit",
    blockedSource: result.available ? undefined : "wham",
    blockedModel: result.available ? undefined : stats.blockedModel,
    blockedScope: result.available ? undefined : stats.blockedScope,
    ...(stats.cooldownReason === "rate_limit" &&
    isBlockedWindowActiveForModel(stats, now, stats.cooldownModel ?? null)
      ? {
          cooldownUntil: undefined,
          cooldownReason: undefined,
          cooldownClassification: undefined,
          cooldownModel: undefined,
        }
      : {}),
  };
}

export type AuthProfileFailureReduction = {
  expectedProfile: AuthProfileCredential;
  reason: AuthProfileFailureReason;
  modelId?: string;
  whamResult: WhamCooldownProbeResult | null;
  probeEligible: boolean;
  observedProfile?: AuthProfileCredential;
  blockGeneration?: ProfileUsageStats;
};

export type PersonalAuthProfileUsageReduction =
  | { kind: "success"; expectedProfile: AuthProfileCredential; lastUsed: number }
  | ({ kind: "failure" } & AuthProfileFailureReduction);

export type PersonalAuthProfileUsageResult = {
  previous: ProfileUsageStats | undefined;
  next: ProfileUsageStats;
  now: number;
};

/** Both writers reduce their current row using the same prepared provider observation. */
export function reduceAuthProfileFailure(
  profile: AuthProfileCredential | undefined,
  previousStats: ProfileUsageStats | undefined,
  input: AuthProfileFailureReduction,
  now: number,
): ProfileUsageStats | undefined {
  if (
    !profile ||
    profile.setup?.replacement ||
    isAuthCooldownBypassedForProvider(profile.provider)
  ) {
    return undefined;
  }
  const { expectedProfile, reason, modelId, whamResult, observedProfile, blockGeneration } = input;
  const currentWhamResult =
    whamResult &&
    input.probeEligible &&
    profile.type === "oauth" &&
    isFutureDateTimestampMs(profile.expires, { nowMs: now }) &&
    isSameWhamCredential(expectedProfile, profile) &&
    ((!whamResult.available && !whamResult.blockedUntil) ||
      (observedProfile &&
        isSameWhamCredential(expectedProfile, observedProfile) &&
        matchesWhamBlockGeneration(previousStats, blockGeneration)))
      ? whamResult
      : null;
  // The probe can only release the credential and block generation it observed.
  if (reason === "no_error_details" && !currentWhamResult) {
    return undefined;
  }
  const existing =
    currentWhamResult?.available && previousStats?.blockedReason === "subscription_limit"
      ? reconcileWhamBlock(previousStats, currentWhamResult, now)
      : (previousStats ?? {});
  const computed = computeNextProfileUsageStats({ existing, now, reason, modelId });
  return currentWhamResult
    ? applyWhamCooldownResult({ existing, computed, now, whamResult: currentWhamResult })
    : computed;
}

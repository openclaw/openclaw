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
import { isBlockedWindowActiveForModel } from "./usage-state.js";

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
  reason: AuthProfileFailureReason;
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
    (params.reason === "rate_limit" ||
      (!params.whamResult.available &&
        params.computed.blockedReason === "subscription_limit" &&
        isBlockedWindowActiveForModel(params.computed, params.now)))
  ) {
    // A probe without an exhausted window or auth evidence adds no local delay:
    // a rate limit keeps only its provider deadline and a block keeps its reset.
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
  observedAt: number;
  reason: AuthProfileFailureReason;
  modelId?: string;
  retryAfterMs?: number;
  whamResult: WhamCooldownProbeResult | null;
  probeEligible: boolean;
};

export type PersonalAuthProfileUsageReduction =
  | { kind: "success"; expectedProfile: AuthProfileCredential; lastUsed: number; modelId?: string }
  | ({ kind: "failure" } & AuthProfileFailureReduction);

/** Both writers reduce their current row using the same prepared provider observation. */
export function reduceAuthProfileFailure(
  profile: AuthProfileCredential | undefined,
  previousStats: ProfileUsageStats | undefined,
  input: AuthProfileFailureReduction,
  now: number,
): ProfileUsageStats | undefined {
  if (!profile || profile.setup?.replacement) {
    return undefined;
  }
  const { expectedProfile, reason, modelId, retryAfterMs, whamResult } = input;
  const currentWhamResult =
    whamResult &&
    input.probeEligible &&
    profile.type === "oauth" &&
    isFutureDateTimestampMs(profile.expires, { nowMs: now }) &&
    isSameWhamCredential(expectedProfile, profile)
      ? whamResult
      : null;
  // Successful use also advances lastProbeAt, including inherited profiles.
  if (currentWhamResult && (previousStats?.lastProbeAt ?? 0) > input.observedAt) {
    return undefined;
  }
  if (reason === "no_error_details" && !currentWhamResult) {
    return undefined;
  }
  const existing =
    currentWhamResult?.available && previousStats?.blockedReason === "subscription_limit"
      ? reconcileWhamBlock(previousStats, currentWhamResult, now)
      : (previousStats ?? {});
  const computed = computeNextProfileUsageStats({ existing, now, reason, modelId, retryAfterMs });
  return currentWhamResult
    ? applyWhamCooldownResult({ existing, computed, now, reason, whamResult: currentWhamResult })
    : computed;
}

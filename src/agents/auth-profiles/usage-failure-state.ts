import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import type { AuthProfileFailureReason, ProfileUsageStats } from "./types.js";
import {
  isActiveUnusableWindow,
  isBlockedWindowActiveForModel,
  isModelScopedCooldownReason,
  resolveProfileUnusableUntil,
} from "./usage-state.js";

export function resolveUsageWindowUntil(now: number, durationMs: number): number {
  if (durationMs <= 0) {
    return now;
  }
  return (
    resolveExpiresAtMsFromDurationMs(Math.max(1, Math.floor(durationMs)), { nowMs: now }) ?? now
  );
}
/** Returns the regular transient-failure cooldown duration for an error count. */
function calculateAuthProfileCooldownMs(errorCount: number): number {
  const normalized = Math.max(1, errorCount);
  if (normalized <= 1) {
    return 30_000; // 30 seconds
  }
  if (normalized <= 2) {
    return 60_000; // 1 minute
  }
  return 5 * 60_000; // 5 minutes max
}

type BackoffFailureReason = Extract<AuthProfileFailureReason, "billing" | "auth_permanent">;

const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Keep the initial billing disable short so inline API keys can retry soon
// after recharge, even though they cannot probe during an active window.
const FAILURE_BACKOFF_POLICIES = {
  billing: {
    baseMs: 10 * 60 * 1000,
    maxMs: 24 * 60 * 60 * 1000,
  },
  auth_permanent: {
    // Recover quickly because some providers surface auth-looking payloads
    // transiently during incidents.
    baseMs: 10 * 60 * 1000,
    maxMs: 60 * 60 * 1000,
  },
} satisfies Record<BackoffFailureReason, { baseMs: number; maxMs: number }>;

function calculateCappedExponentialBackoffMs(params: {
  errorCount: number;
  baseMs: number;
  maxMs: number;
}): number {
  const normalized = Math.max(1, params.errorCount);
  const baseMs = Math.max(1, params.baseMs);
  const maxMs = Math.max(baseMs, params.maxMs);
  const maxExponent = Math.max(0, Math.ceil(Math.log2(maxMs / baseMs)));
  const exponent = Math.min(normalized - 1, maxExponent);
  const raw = baseMs * 2 ** exponent;
  return Math.min(maxMs, raw);
}

function resolveNextCooldownModel(
  existing: ProfileUsageStats,
  now: number,
  reason: AuthProfileFailureReason,
  modelId: string | undefined,
): string | undefined {
  if (!isModelScopedCooldownReason(reason)) {
    return undefined;
  }
  if (!isActiveUnusableWindow(existing.cooldownUntil, now)) {
    return modelId;
  }
  // Keep an active scope only while every failure names the same model.
  // An already profile-wide window cannot narrow until it expires.
  const previousModel = existing.cooldownModel;
  return !previousModel || previousModel === modelId ? previousModel : undefined;
}

/**
 * Provider timing alone bounds a rate limit: there is no local counter, backoff or
 * cap. A later provider deadline extends the shared window; an earlier one cannot
 * shorten it. Without usable timing the profile stays available, and
 * lastRateLimitAt lets session recovery return to it after a fallback.
 */
function computeRateLimitUsageStats(params: {
  existing: ProfileUsageStats;
  now: number;
  modelId?: string;
  retryAfterMs?: number;
}): ProfileUsageStats {
  const { existing, now } = params;
  const providerUntil = resolveUsageWindowUntil(now, params.retryAfterMs ?? 0);
  if (providerUntil <= now) {
    return { ...existing, lastRateLimitAt: now };
  }
  const activeUntil = isActiveUnusableWindow(existing.cooldownUntil, now)
    ? (existing.cooldownUntil ?? 0)
    : 0;
  return {
    ...existing,
    lastRateLimitAt: now,
    cooldownUntil: Math.max(activeUntil, providerUntil),
    cooldownReason: "rate_limit",
    cooldownClassification: undefined,
    cooldownModel: resolveNextCooldownModel(existing, now, "rate_limit", params.modelId),
  };
}

export function computeNextProfileUsageStats(params: {
  existing: ProfileUsageStats;
  now: number;
  reason: AuthProfileFailureReason;
  modelId?: string;
  retryAfterMs?: number;
}): ProfileUsageStats {
  if (params.reason === "rate_limit") {
    // The provider quota writer already recorded this failure and its retry deadline.
    return params.existing.blockedReason === "subscription_limit" &&
      isBlockedWindowActiveForModel(params.existing, params.now, params.modelId ?? null)
      ? params.existing
      : computeRateLimitUsageStats(params);
  }
  const windowExpired =
    typeof params.existing.lastFailureAt === "number" &&
    params.existing.lastFailureAt > 0 &&
    params.now - params.existing.lastFailureAt > FAILURE_WINDOW_MS;

  // If the previous cooldown has already expired, reset error counters so the
  // profile gets a fresh backoff window. clearExpiredCooldowns() does this
  // in-memory during profile ordering, but the on-disk state may still carry
  // the old counters when the lock-based updater reads a fresh store. Without
  // this check, stale error counts from an expired cooldown cause the next
  // failure to escalate to a much longer cooldown (e.g. 1 min → 25 min).
  const unusableUntil = resolveProfileUnusableUntil(params.existing);
  const previousCooldownExpired = typeof unusableUntil === "number" && params.now >= unusableUntil;

  const shouldResetCounters = windowExpired || previousCooldownExpired;
  const baseErrorCount = shouldResetCounters ? 0 : (params.existing.errorCount ?? 0);
  const nextErrorCount = baseErrorCount + 1;
  const failureCounts = shouldResetCounters ? {} : { ...params.existing.failureCounts };
  failureCounts[params.reason] = (failureCounts[params.reason] ?? 0) + 1;

  const updatedStats: ProfileUsageStats = {
    ...params.existing,
    // Exact provider diagnostics describe only the cooldown generation that
    // produced them; every ordinary failure replaces that diagnostic state.
    cooldownClassification: undefined,
    errorCount: nextErrorCount,
    failureCounts,
    lastFailureAt: params.now,
  };

  const disabledFailureReason =
    params.reason === "billing" || params.reason === "auth_permanent" ? params.reason : null;
  const backoffMs = disabledFailureReason
    ? calculateCappedExponentialBackoffMs({
        errorCount: failureCounts[disabledFailureReason] ?? 1,
        ...FAILURE_BACKOFF_POLICIES[disabledFailureReason],
      })
    : calculateAuthProfileCooldownMs(nextErrorCount);
  const window = disabledFailureReason ? "disabledUntil" : "cooldownUntil";
  // Retries within either active window cannot push recovery further out.
  const existingUntil = params.existing[window];
  const recomputedUntil = resolveUsageWindowUntil(params.now, backoffMs);
  updatedStats[window] =
    typeof existingUntil === "number" && existingUntil > params.now
      ? existingUntil
      : recomputedUntil;
  if (disabledFailureReason) {
    updatedStats.disabledReason = disabledFailureReason;
  } else {
    updatedStats.cooldownReason = params.reason;
    updatedStats.cooldownModel = resolveNextCooldownModel(
      params.existing,
      params.now,
      params.reason,
      params.modelId,
    );
  }

  return updatedStats;
}

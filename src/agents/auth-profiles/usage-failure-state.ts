import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import type { AuthProfileFailureReason, ProfileUsageStats } from "./types.js";
import {
  isBlockedWindowActiveForModel,
  isModelScopedCooldownReason,
  resolveProfileUnusableUntil,
} from "./usage-state.js";

export function resolveUsageWindowUntil(now: number, durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
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

// Without a provider reset, grow failed half-open probes up to one billing day:
// frequent retries risk metered fallback spend, while a finite cap still retries daily.
const RATE_LIMIT_BACKOFF_BASE_MS = 30_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

type DisabledFailureReason = Extract<AuthProfileFailureReason, "billing" | "auth_permanent">;

const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Keep the initial billing disable short so inline API keys can retry soon
// after recharge, even though they cannot probe during an active window.
const DISABLED_FAILURE_BACKOFF_POLICIES = {
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
} satisfies Record<DisabledFailureReason, { baseMs: number; maxMs: number }>;

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

function keepActiveWindowOrRecompute(params: {
  existingUntil: number | undefined;
  now: number;
  recomputedUntil: number;
}): number {
  const { existingUntil, now, recomputedUntil } = params;
  const hasActiveWindow =
    typeof existingUntil === "number" && Number.isFinite(existingUntil) && existingUntil > now;
  return hasActiveWindow ? existingUntil : recomputedUntil;
}

export function computeNextProfileUsageStats(params: {
  existing: ProfileUsageStats;
  now: number;
  reason: AuthProfileFailureReason;
  modelId?: string;
}): ProfileUsageStats {
  // The provider quota writer already recorded this failure and its retry deadline.
  if (
    params.reason === "rate_limit" &&
    params.existing.blockedReason === "subscription_limit" &&
    isBlockedWindowActiveForModel(params.existing, params.now, params.modelId ?? null)
  ) {
    return params.existing;
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

  // A rate-limit profile remains half-open until a real request succeeds. Its
  // dedicated counter survives expiry, while the aggregate counter resets so
  // unrelated failures do not inherit the rate-limit backoff history.
  const shouldResetAggregateCounter = windowExpired || previousCooldownExpired;
  const baseErrorCount = shouldResetAggregateCounter ? 0 : (params.existing.errorCount ?? 0);
  const nextErrorCount = baseErrorCount + 1;
  const preservedRateLimitCount = params.existing.failureCounts?.rate_limit;
  const failureCounts = shouldResetAggregateCounter
    ? preservedRateLimitCount
      ? { rate_limit: preservedRateLimitCount }
      : {}
    : { ...params.existing.failureCounts };
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

  if (disabledFailureReason) {
    const disableCount = failureCounts[disabledFailureReason] ?? 1;
    const backoffMs = calculateCappedExponentialBackoffMs({
      errorCount: disableCount,
      ...DISABLED_FAILURE_BACKOFF_POLICIES[disabledFailureReason],
    });
    // Keep active disable windows immutable so retries within the window cannot
    // extend recovery time indefinitely.
    updatedStats.disabledUntil = keepActiveWindowOrRecompute({
      existingUntil: params.existing.disabledUntil,
      now: params.now,
      recomputedUntil: resolveUsageWindowUntil(params.now, backoffMs),
    });
    updatedStats.disabledReason = disabledFailureReason;
  } else {
    const backoffMs =
      params.reason === "rate_limit"
        ? calculateCappedExponentialBackoffMs({
            errorCount: failureCounts.rate_limit ?? 1,
            baseMs: RATE_LIMIT_BACKOFF_BASE_MS,
            maxMs: RATE_LIMIT_BACKOFF_MAX_MS,
          })
        : calculateAuthProfileCooldownMs(nextErrorCount);
    // Keep active cooldown windows immutable so retries within the window
    // cannot push recovery further out.
    updatedStats.cooldownUntil = keepActiveWindowOrRecompute({
      existingUntil: params.existing.cooldownUntil,
      now: params.now,
      recomputedUntil: resolveUsageWindowUntil(params.now, backoffMs),
    });
    // Update cooldown metadata based on whether the window is still active
    // and whether the same or a different model is failing.
    const existingCooldownActive =
      typeof params.existing.cooldownUntil === "number" &&
      params.existing.cooldownUntil > params.now;
    if (existingCooldownActive) {
      // Always use the latest failure reason so that downstream consumers
      // (e.g. isProfileInCooldown model-bypass) see the most recent signal.
      // A non-rate_limit failure (auth, billing, …) is profile-wide, so
      // upgrading from rate_limit → auth correctly blocks all models.
      updatedStats.cooldownReason = params.reason;
      // If a different model fails during an active window, widen the scope
      // to all models (undefined) so neither model bypasses the cooldown.
      if (
        params.existing.cooldownModel &&
        params.modelId &&
        params.existing.cooldownModel !== params.modelId
      ) {
        updatedStats.cooldownModel = undefined;
      } else if (
        isModelScopedCooldownReason(params.reason) &&
        !params.modelId &&
        params.existing.cooldownModel
      ) {
        // Unknown originating model during an active model-scoped cooldown:
        // widen scope conservatively so no model can bypass on stale metadata.
        updatedStats.cooldownModel = undefined;
      } else if (!isModelScopedCooldownReason(params.reason)) {
        // Profile-wide failures (auth, billing, format, server_error, ...) —
        // clear model scope so that no model can bypass.
        updatedStats.cooldownModel = undefined;
      } else {
        updatedStats.cooldownModel = params.existing.cooldownModel;
      }
    } else {
      updatedStats.cooldownReason = params.reason;
      updatedStats.cooldownModel = isModelScopedCooldownReason(params.reason)
        ? params.modelId
        : undefined;
    }
  }

  return updatedStats;
}

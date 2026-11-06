import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isStringOption } from "../../utils/string-readers.js";
import type {
  AuthProfileBlockedReason,
  AuthProfileBlockedSource,
  AuthProfileCooldownClassification,
  ProfileUsageStats,
} from "./types.js";
import { AUTH_PROFILE_FAILURE_REASONS } from "./usage-state.js";

const AUTH_COOLDOWN_CLASSIFICATIONS = new Set<AuthProfileCooldownClassification>([
  "wham_token_expired",
  "wham_account_dead",
]);
const AUTH_BLOCKED_REASONS = new Set<AuthProfileBlockedReason>(["subscription_limit"]);
const AUTH_BLOCKED_SOURCES = new Set<AuthProfileBlockedSource>(["codex_rate_limits", "wham"]);

function normalizeEnumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
): T | undefined {
  return isStringOption(value, allowed) ? value : undefined;
}

function normalizeFailureCounts(raw: unknown): ProfileUsageStats["failureCounts"] {
  if (!isRecord(raw)) {
    return undefined;
  }
  const normalized: NonNullable<ProfileUsageStats["failureCounts"]> = {};
  for (const [rawReason, count] of Object.entries(raw)) {
    const reason = normalizeEnumValue(rawReason, AUTH_PROFILE_FAILURE_REASONS);
    if (reason === undefined || reason === "rate_limit") {
      continue;
    }
    if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
      continue;
    }
    normalized[reason] = Math.trunc(count);
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/** Normalizes one credential owner's persisted cooldown and usage record. */
export function coerceProfileUsageStats(raw: unknown): ProfileUsageStats | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const cooldownReason = normalizeEnumValue(raw.cooldownReason, AUTH_PROFILE_FAILURE_REASONS);
  const cooldownClassification = normalizeEnumValue(
    raw.cooldownClassification,
    AUTH_COOLDOWN_CLASSIFICATIONS,
  );
  const stats: ProfileUsageStats = {};
  function setStat<K extends keyof ProfileUsageStats>(key: K, value: ProfileUsageStats[K]): void {
    if (value !== undefined) {
      stats[key] = value;
    }
  }
  setStat("lastUsed", asFiniteNumber(raw.lastUsed));
  setStat("blockedUntil", asFiniteNumber(raw.blockedUntil));
  setStat("blockedReason", normalizeEnumValue(raw.blockedReason, AUTH_BLOCKED_REASONS));
  setStat("blockedSource", normalizeEnumValue(raw.blockedSource, AUTH_BLOCKED_SOURCES));
  setStat("blockedModel", normalizeOptionalString(raw.blockedModel));
  setStat("blockedScope", raw.blockedScope === "model" ? "model" : undefined);
  setStat("cooldownUntil", asFiniteNumber(raw.cooldownUntil));
  setStat("cooldownReason", cooldownReason);
  setStat(
    "cooldownClassification",
    (cooldownClassification === "wham_token_expired" && cooldownReason === "auth") ||
      (cooldownClassification === "wham_account_dead" && cooldownReason === "auth_permanent")
      ? cooldownClassification
      : undefined,
  );
  setStat("cooldownModel", normalizeOptionalString(raw.cooldownModel));
  setStat("disabledUntil", asFiniteNumber(raw.disabledUntil));
  setStat("disabledReason", normalizeEnumValue(raw.disabledReason, AUTH_PROFILE_FAILURE_REASONS));
  setStat("errorCount", asFiniteNumber(raw.errorCount));
  setStat("failureCounts", normalizeFailureCounts(raw.failureCounts));
  setStat("lastFailureAt", asFiniteNumber(raw.lastFailureAt));
  setStat("lastRateLimitAt", asFiniteNumber(raw.lastRateLimitAt));
  setStat("lastProbeAt", asFiniteNumber(raw.lastProbeAt));
  releaseRetiredRateLimitBackoff(stats, raw.failureCounts);
  return Object.keys(stats).length > 0 ? stats : undefined;
}

/**
 * Releases state written by the retired local rate-limit backoff. Only that writer
 * persisted `failureCounts.rate_limit`, so its rate-limit window has no provider
 * basis; the next provider-timed failure records a fresh one. The count survives
 * only as the session-recovery fact it also served.
 */
function releaseRetiredRateLimitBackoff(stats: ProfileUsageStats, rawCounts: unknown): void {
  const legacyCount = isRecord(rawCounts) ? asFiniteNumber(rawCounts.rate_limit) : undefined;
  if (legacyCount === undefined || legacyCount <= 0) {
    return;
  }
  stats.lastRateLimitAt ??= stats.lastFailureAt ?? 0;
  if (stats.cooldownReason === "rate_limit") {
    delete stats.cooldownUntil;
    delete stats.cooldownReason;
    delete stats.cooldownClassification;
    delete stats.cooldownModel;
    delete stats.errorCount;
  }
}

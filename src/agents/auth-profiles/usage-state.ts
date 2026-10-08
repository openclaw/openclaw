import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { isStringOption } from "../../utils/string-readers.js";
import type { AuthProfileFailureReason, AuthProfileStore, ProfileUsageStats } from "./types.js";

const FAILURE_REASON_PRIORITY: AuthProfileFailureReason[] = [
  "auth_permanent",
  "auth",
  "session_expired",
  "billing",
  "format",
  "model_not_found",
  "overloaded",
  "timeout",
  "rate_limit",
  "empty_response",
  "no_error_details",
  "unclassified",
  "unknown",
];
export const AUTH_PROFILE_FAILURE_REASONS: ReadonlySet<AuthProfileFailureReason> = new Set(
  FAILURE_REASON_PRIORITY,
);

const [blockedFields, cooldownFields, disabledFields] = [
  ["blockedUntil", "blockedReason", "blockedSource", "blockedModel", "blockedScope"],
  ["cooldownUntil", "cooldownReason", "cooldownClassification", "cooldownModel"],
  ["disabledUntil", "disabledReason"],
] as const;
const expiryWindows = [cooldownFields, blockedFields, disabledFields];
const clearedWindows = Object.fromEntries(
  [...blockedFields, ...cooldownFields, ...disabledFields].map((field) => [field, undefined]),
);

/** Clears failure windows while preserving unrelated usage history. */
export function resetAuthProfileFailureState(
  existing: ProfileUsageStats,
  overrides?: Partial<ProfileUsageStats>,
): ProfileUsageStats {
  return {
    ...existing,
    errorCount: 0,
    ...clearedWindows,
    failureCounts: undefined,
    ...overrides,
  };
}

/** Returns true for providers whose auth-profile cooldowns are provider-managed. */
export function isAuthCooldownBypassedForProvider(provider: string | undefined): boolean {
  const normalized = normalizeProviderId(provider ?? "");
  return normalized === "openrouter" || normalized === "kilocode";
}

export function resolveInlineProviderApiKeyUsageId(provider: string): string {
  return `inline-api-key:${normalizeProviderId(provider)}`;
}

/** Reads inline-key health using the same identity and bypass policy as its writer. */
export function readInlineProviderApiKeyUsage(store: AuthProfileStore, provider: string) {
  const stats = isAuthCooldownBypassedForProvider(provider)
    ? undefined
    : store.usageStats?.[resolveInlineProviderApiKeyUsageId(provider)];
  return { stats, unusableUntil: stats ? resolveProfileUnusableUntil(stats) : null };
}

// Per-attempt transient failures (#87462, #116464): block only the failing
// model so fallback models on the same auth profile can still try. A model that
// the provider does not serve (model_not_found) says nothing about sibling
// models, so it stays model-scoped too. Other reasons (auth, billing, format,
// server_error) remain profile-wide.
/** Returns true when a failure should only cool down the failing model. */
export function isModelScopedCooldownReason(reason: AuthProfileFailureReason | undefined): boolean {
  return reason === "rate_limit" || reason === "timeout" || reason === "model_not_found";
}

/** Resolves the latest active blocked/cooldown/disabled timestamp for a profile. */
export function resolveProfileUnusableUntil(
  stats: Pick<
    ProfileUsageStats,
    | "blockedUntil"
    | "blockedModel"
    | "blockedScope"
    | "cooldownUntil"
    | "cooldownReason"
    | "cooldownModel"
    | "disabledUntil"
  >,
  forModel?: string | null,
): number | null {
  const blockedUntil = isBlockScopedToDifferentModel(stats, forModel)
    ? undefined
    : stats.blockedUntil;
  const cooldownUntil =
    forModel === null && isModelScopedCooldownReason(stats.cooldownReason) && stats.cooldownModel
      ? undefined
      : stats.cooldownUntil;
  const values = [blockedUntil, cooldownUntil, stats.disabledUntil]
    .map((value) => asDateTimestampMs(value))
    .filter((value): value is number => value !== undefined && value > 0);
  return values.length > 0 ? Math.max(...values) : null;
}

/** Returns true when an unusable timestamp is active at the supplied clock time. */
export function isActiveUnusableWindow(until: number | undefined, now: number): boolean {
  const timestamp = asDateTimestampMs(until);
  return timestamp !== undefined && timestamp > 0 && now < timestamp;
}

export function isBlockedWindowActiveForModel(
  stats: Pick<ProfileUsageStats, "blockedUntil" | "blockedModel" | "blockedScope">,
  now: number,
  forModel?: string | null,
): boolean {
  return (
    !isBlockScopedToDifferentModel(stats, forModel) &&
    isActiveUnusableWindow(stats.blockedUntil, now)
  );
}

function isBlockScopedToDifferentModel(
  stats: Pick<ProfileUsageStats, "blockedModel" | "blockedScope">,
  forModel?: string | null,
): boolean {
  // Legacy rows carried blockedModel for profile-wide blocks without a scope marker.
  // Only explicit model scope narrows them; unmarked rows stay wide until expiry.
  return Boolean(
    (forModel === null || forModel) &&
    stats.blockedScope === "model" &&
    stats.blockedModel &&
    (forModel === null || stats.blockedModel !== forModel),
  );
}

export function isCooldownScopedToDifferentModel(
  stats: Pick<ProfileUsageStats, "cooldownReason" | "cooldownModel">,
  forModel?: string | null,
): boolean {
  return Boolean(
    (forModel === null || forModel) &&
    isModelScopedCooldownReason(stats.cooldownReason) &&
    stats.cooldownModel &&
    (forModel === null || stats.cooldownModel !== forModel),
  );
}

function shouldBypassModelScopedCooldown(
  stats: ProfileUsageStats,
  now: number,
  forModel?: string | null,
): boolean {
  return (
    isCooldownScopedToDifferentModel(stats, forModel) &&
    !isBlockedWindowActiveForModel(stats, now, forModel) &&
    !isActiveUnusableWindow(stats.disabledUntil, now)
  );
}

/**
 * Check if a profile is currently in cooldown (due to rate limits, overload, or other transient failures).
 */
export function isProfileInCooldown(
  store: AuthProfileStore,
  profileId: string,
  now?: number,
  forModel?: string | null,
): boolean {
  if (isAuthCooldownBypassedForProvider(store.profiles[profileId]?.provider)) {
    return false;
  }
  const stats = store.usageStats?.[profileId];
  if (!stats) {
    return false;
  }
  const ts = now ?? Date.now();
  // Model-aware bypass: if the cooldown was caused by a model-scoped reason on a
  // specific model and the caller is requesting a *different* model, allow it.
  // We still honour profile-wide blocked/disabled windows; they must not be
  // short-circuited by model scoping.
  if (shouldBypassModelScopedCooldown(stats, ts, forModel)) {
    return false;
  }
  const unusableUntil = resolveProfileUnusableUntil(stats, forModel);
  return unusableUntil ? ts < unusableUntil : false;
}

/**
 * Return the soonest `unusableUntil` timestamp (ms epoch) among the given
 * profiles, or `null` when no profile has a recorded cooldown. Note: the
 * returned timestamp may be in the past if the cooldown has already expired.
 */
export function getSoonestCooldownExpiry(
  store: AuthProfileStore,
  profileIds: string[],
  options?: { now?: number; forModel?: string },
): number | null {
  const ts = options?.now ?? Date.now();
  let soonest: number | null = null;
  let latestMatchingModelCooldown: number | null = null;
  for (const id of profileIds) {
    const stats = store.usageStats?.[id];
    if (!stats) {
      continue;
    }
    if (shouldBypassModelScopedCooldown(stats, ts, options?.forModel)) {
      continue;
    }
    const until = resolveProfileUnusableUntil(stats, options?.forModel);
    if (until === null) {
      continue;
    }
    const matchingModelScopedCooldown =
      options?.forModel &&
      stats.cooldownReason === "rate_limit" &&
      stats.cooldownModel === options.forModel &&
      !isBlockedWindowActiveForModel(stats, ts, options.forModel) &&
      !isActiveUnusableWindow(stats.disabledUntil, ts);
    if (matchingModelScopedCooldown) {
      latestMatchingModelCooldown =
        latestMatchingModelCooldown === null ? until : Math.max(latestMatchingModelCooldown, until);
      continue;
    }
    if (soonest === null || until < soonest) {
      soonest = until;
    }
  }
  if (soonest === null) {
    return latestMatchingModelCooldown;
  }
  if (latestMatchingModelCooldown === null) {
    return soonest;
  }
  return Math.min(soonest, latestMatchingModelCooldown);
}

/** Clear each expired window in memory; the next store write persists it. */
export function clearExpiredCooldowns(store: AuthProfileStore, now?: number): boolean {
  const usageStats = store.usageStats;
  if (!usageStats) {
    return false;
  }

  const ts = now ?? Date.now();
  const expired = (until: number | undefined) =>
    typeof until === "number" && Number.isFinite(until) && until > 0 && ts >= until;
  let mutated = false;

  for (const [profileId, stats] of Object.entries(usageStats)) {
    if (!stats) {
      continue;
    }

    let profileMutated = false;
    for (const fields of expiryWindows) {
      if (expired(stats[fields[0]])) {
        for (const field of fields) {
          stats[field] = undefined;
        }
        profileMutated = true;
      }
    }

    // Reset the aggregate counter when ALL cooldowns have expired so unrelated
    // failures get a fair retry window. Only the rate-limit-specific counter
    // survives a half-open probe; success still clears it. Preserves
    // lastFailureAt for other failures' decay check in computeNextProfileUsageStats.
    if (profileMutated && !resolveProfileUnusableUntil(stats)) {
      stats.errorCount = 0;
      const rateLimitFailureCount = stats.failureCounts?.rate_limit;
      stats.failureCounts = rateLimitFailureCount
        ? { rate_limit: rateLimitFailureCount }
        : undefined;
    }

    if (profileMutated) {
      usageStats[profileId] = stats;
      mutated = true;
    }
  }

  return mutated;
}

/**
 * Infer the most likely reason all candidate profiles are currently unavailable.
 *
 * We prefer explicit active `disabledReason` values (for example billing/auth)
 * over generic cooldown buckets, then fall back to failure-count signals.
 */
export function resolveProfilesUnavailableReason(params: {
  store: AuthProfileStore;
  profileIds: string[];
  now?: number;
}): AuthProfileFailureReason | null {
  const now = params.now ?? Date.now();
  const scores = new Map<AuthProfileFailureReason, number>();
  const addScore = (reason: AuthProfileFailureReason, value: number) => {
    if (!AUTH_PROFILE_FAILURE_REASONS.has(reason) || value <= 0 || !Number.isFinite(value)) {
      return;
    }
    scores.set(reason, (scores.get(reason) ?? 0) + value);
  };

  for (const profileId of params.profileIds) {
    const stats = params.store.usageStats?.[profileId];
    if (!stats) {
      continue;
    }

    const disabledActive = isActiveUnusableWindow(stats.disabledUntil, now);
    if (
      disabledActive &&
      stats.disabledReason &&
      AUTH_PROFILE_FAILURE_REASONS.has(stats.disabledReason)
    ) {
      // Disabled reasons are explicit and high-signal; weight heavily.
      addScore(stats.disabledReason, 1_000);
      continue;
    }

    if (isActiveUnusableWindow(stats.blockedUntil, now)) {
      addScore("rate_limit", 1_000);
      continue;
    }

    const cooldownActive = isActiveUnusableWindow(stats.cooldownUntil, now);
    if (!cooldownActive) {
      continue;
    }

    if (stats.cooldownReason && AUTH_PROFILE_FAILURE_REASONS.has(stats.cooldownReason)) {
      addScore(stats.cooldownReason, 1_000);
      continue;
    }

    let recordedReason = false;
    for (const [reason, rawCount] of Object.entries(stats.failureCounts ?? {})) {
      const count = typeof rawCount === "number" ? rawCount : 0;
      if (!isStringOption(reason, AUTH_PROFILE_FAILURE_REASONS) || count <= 0) {
        continue;
      }
      addScore(reason, count);
      recordedReason = true;
    }
    if (!recordedReason) {
      // No failure counts recorded for this cooldown window. Previously this
      // defaulted to "rate_limit", which caused false "rate limit reached"
      // warnings when the actual reason was unknown (e.g. transient network
      // blip or server error without a classified failure count).
      addScore("unknown", 1);
    }
  }

  let best: AuthProfileFailureReason | null = null;
  let bestScore = -1;
  for (const reason of FAILURE_REASON_PRIORITY) {
    const score = scores.get(reason);
    if (score !== undefined && score > bestScore) {
      best = reason;
      bestScore = score;
    }
  }
  return best;
}

/** Resolves the display-facing unusable timestamp, honoring provider bypasses. */
export function resolveProfileUnusableUntilForDisplay(
  store: AuthProfileStore,
  profileId: string,
): number | null {
  if (isAuthCooldownBypassedForProvider(store.profiles[profileId]?.provider)) {
    return null;
  }
  const stats = store.usageStats?.[profileId];
  if (!stats) {
    return null;
  }
  return resolveProfileUnusableUntil(stats);
}

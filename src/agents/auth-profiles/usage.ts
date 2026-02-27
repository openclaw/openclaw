import type { OpenClawConfig } from "../../config/config.js";
import { normalizeProviderId } from "../model-selection.js";
import { saveAuthProfileStore, updateAuthProfileStoreWithLock } from "./store.js";
import type { AuthProfileFailureReason, AuthProfileStore, ProfileUsageStats } from "./types.js";

const FAILURE_REASON_PRIORITY: AuthProfileFailureReason[] = [
  "auth_permanent",
  "auth",
  "billing",
  "format",
  "model_not_found",
  "timeout",
  "rate_limit",
  "unknown",
];
const FAILURE_REASON_SET = new Set<AuthProfileFailureReason>(FAILURE_REASON_PRIORITY);
const FAILURE_REASON_ORDER = new Map<AuthProfileFailureReason, number>(
  FAILURE_REASON_PRIORITY.map((reason, index) => [reason, index]),
);

function isAuthCooldownBypassedForProvider(provider: string | undefined): boolean {
  return normalizeProviderId(provider ?? "") === "openrouter";
}

export function resolveProfileUnusableUntil(
  stats: Pick<ProfileUsageStats, "cooldownUntil" | "disabledUntil">,
): number | null {
  const values = [stats.cooldownUntil, stats.disabledUntil]
    .filter((value): value is number => typeof value === "number")
    .filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) {
    return null;
  }
  return Math.max(...values);
}

/**
 * Check if a profile is currently in cooldown (due to rate limiting or errors).
 */
export function isProfileInCooldown(store: AuthProfileStore, profileId: string): boolean {
  if (isAuthCooldownBypassedForProvider(store.profiles[profileId]?.provider)) {
    return false;
  }
  const stats = store.usageStats?.[profileId];
  if (!stats) {
    return false;
  }
  const unusableUntil = resolveProfileUnusableUntil(stats);
  return unusableUntil ? Date.now() < unusableUntil : false;
}

function isActiveUnusableWindow(until: number | undefined, now: number): boolean {
  return typeof until === "number" && Number.isFinite(until) && until > 0 && now < until;
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
    if (!FAILURE_REASON_SET.has(reason) || value <= 0 || !Number.isFinite(value)) {
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
    if (disabledActive && stats.disabledReason && FAILURE_REASON_SET.has(stats.disabledReason)) {
      // Disabled reasons are explicit and high-signal; weight heavily.
      addScore(stats.disabledReason, 1_000);
      continue;
    }

    const cooldownActive = isActiveUnusableWindow(stats.cooldownUntil, now);
    if (!cooldownActive) {
      continue;
    }

    let recordedReason = false;
    for (const [rawReason, rawCount] of Object.entries(stats.failureCounts ?? {})) {
      const reason = rawReason as AuthProfileFailureReason;
      const count = typeof rawCount === "number" ? rawCount : 0;
      if (!FAILURE_REASON_SET.has(reason) || count <= 0) {
        continue;
      }
      addScore(reason, count);
      recordedReason = true;
    }
    if (!recordedReason) {
      addScore("rate_limit", 1);
    }
  }

  if (scores.size === 0) {
    return null;
  }

  let best: AuthProfileFailureReason | null = null;
  let bestScore = -1;
  let bestPriority = Number.MAX_SAFE_INTEGER;
  for (const reason of FAILURE_REASON_PRIORITY) {
    const score = scores.get(reason);
    if (typeof score !== "number") {
      continue;
    }
    const priority = FAILURE_REASON_ORDER.get(reason) ?? Number.MAX_SAFE_INTEGER;
    if (score > bestScore || (score === bestScore && priority < bestPriority)) {
      best = reason;
      bestScore = score;
      bestPriority = priority;
    }
  }
  return best;
}

/**
 * Check if a profile is in cooldown for a specific model. Billing/auth
 * disables apply to all models, but rate-limit / timeout cooldowns are
 * checked per-model when a model key is provided.
 */
export function isProfileInCooldownForModel(
  store: AuthProfileStore,
  profileId: string,
  model?: string,
): boolean {
  const stats = store.usageStats?.[profileId];
  if (!stats) {
    return false;
  }

  // Billing/auth disabled applies to ALL models
  if (
    typeof stats.disabledUntil === "number" &&
    Number.isFinite(stats.disabledUntil) &&
    stats.disabledUntil > 0 &&
    Date.now() < stats.disabledUntil
  ) {
    return true;
  }

  // No model specified → fall back to global cooldown check
  if (!model) {
    return isProfileInCooldown(store, profileId);
  }

  // Check model-specific cooldown
  const mc = stats.modelCooldowns?.[model];
  if (mc?.cooldownUntil && Date.now() < mc.cooldownUntil) {
    return true;
  }

  return false;
}

/**
 * Return the soonest `unusableUntil` timestamp (ms epoch) among the given
 * profiles, or `null` when no profile has a recorded cooldown. Note: the
 * returned timestamp may be in the past if the cooldown has already expired.
 */
export function getSoonestCooldownExpiry(
  store: AuthProfileStore,
  profileIds: string[],
): number | null {
  let soonest: number | null = null;
  const consider = (until: unknown) => {
    if (typeof until !== "number" || !Number.isFinite(until) || until <= 0) {
      return;
    }
    if (soonest === null || until < soonest) {
      soonest = until;
    }
  };
  for (const id of profileIds) {
    const stats = store.usageStats?.[id];
    if (!stats) {
      continue;
    }
    consider(resolveProfileUnusableUntil(stats));
    // Also consider per-model cooldowns so probe timing accounts for them
    if (stats.modelCooldowns) {
      for (const mc of Object.values(stats.modelCooldowns)) {
        consider(mc.cooldownUntil);
      }
    }
  }
  return soonest;
}

/**
 * Clear expired cooldowns from all profiles in the store.
 *
 * When `cooldownUntil` or `disabledUntil` has passed, the corresponding fields
 * are removed and error counters are reset so the profile gets a fresh start
 * (circuit-breaker half-open → closed). Without this, a stale `errorCount`
 * causes the *next* transient failure to immediately escalate to a much longer
 * cooldown — the root cause of profiles appearing "stuck" after rate limits.
 *
 * `cooldownUntil` and `disabledUntil` are handled independently: if a profile
 * has both and only one has expired, only that field is cleared.
 *
 * Mutates the in-memory store; disk persistence happens lazily on the next
 * store write (e.g. `markAuthProfileUsed` / `markAuthProfileFailure`), which
 * matches the existing save pattern throughout the auth-profiles module.
 *
 * @returns `true` if any profile was modified.
 */
export function clearExpiredCooldowns(store: AuthProfileStore, now?: number): boolean {
  const usageStats = store.usageStats;
  if (!usageStats) {
    return false;
  }

  const ts = now ?? Date.now();
  let mutated = false;

  for (const [profileId, stats] of Object.entries(usageStats)) {
    if (!stats) {
      continue;
    }

    let profileMutated = false;
    const cooldownExpired =
      typeof stats.cooldownUntil === "number" &&
      Number.isFinite(stats.cooldownUntil) &&
      stats.cooldownUntil > 0 &&
      ts >= stats.cooldownUntil;
    const disabledExpired =
      typeof stats.disabledUntil === "number" &&
      Number.isFinite(stats.disabledUntil) &&
      stats.disabledUntil > 0 &&
      ts >= stats.disabledUntil;

    if (cooldownExpired) {
      stats.cooldownUntil = undefined;
      profileMutated = true;
    }
    if (disabledExpired) {
      stats.disabledUntil = undefined;
      stats.disabledReason = undefined;
      profileMutated = true;
    }

    // Clear expired model-level cooldowns
    if (stats.modelCooldowns) {
      for (const [modelKey, mc] of Object.entries(stats.modelCooldowns)) {
        if (
          typeof mc.cooldownUntil === "number" &&
          Number.isFinite(mc.cooldownUntil) &&
          mc.cooldownUntil > 0 &&
          ts >= mc.cooldownUntil
        ) {
          delete stats.modelCooldowns[modelKey];
          profileMutated = true;
        }
      }
      // Remove the map entirely if empty
      if (Object.keys(stats.modelCooldowns).length === 0) {
        stats.modelCooldowns = undefined;
      }
    }

    // Reset error counters when ALL cooldowns have expired so the profile gets
    // a fair retry window. Preserves lastFailureAt for the failureWindowMs
    // decay check in computeNextProfileUsageStats.
    if (profileMutated && !resolveProfileUnusableUntil(stats)) {
      stats.errorCount = 0;
      stats.failureCounts = undefined;
    }

    if (profileMutated) {
      usageStats[profileId] = stats;
      mutated = true;
    }
  }

  return mutated;
}

/**
 * Mark a profile as successfully used. Resets error count and updates lastUsed.
 * Uses store lock to avoid overwriting concurrent usage updates.
 */
export async function markAuthProfileUsed(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
}): Promise<void> {
  const { store, profileId, agentDir } = params;
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      if (!freshStore.profiles[profileId]) {
        return false;
      }
      freshStore.usageStats = freshStore.usageStats ?? {};
      freshStore.usageStats[profileId] = {
        ...freshStore.usageStats[profileId],
        lastUsed: Date.now(),
        errorCount: 0,
        cooldownUntil: undefined,
        disabledUntil: undefined,
        disabledReason: undefined,
        failureCounts: undefined,
        modelCooldowns: undefined,
      };
      return true;
    },
  });
  if (updated) {
    store.usageStats = updated.usageStats;
    return;
  }
  if (!store.profiles[profileId]) {
    return;
  }

  store.usageStats = store.usageStats ?? {};
  store.usageStats[profileId] = {
    ...store.usageStats[profileId],
    lastUsed: Date.now(),
    errorCount: 0,
    cooldownUntil: undefined,
    disabledUntil: undefined,
    disabledReason: undefined,
    failureCounts: undefined,
    modelCooldowns: undefined,
  };
  saveAuthProfileStore(store, agentDir);
}

export function calculateAuthProfileCooldownMs(
  errorCount: number,
  reason?: AuthProfileFailureReason,
): number {
  const normalized = Math.max(1, errorCount);

  // Timeout uses a shorter cooldown — likely transient network/provider issue
  if (reason === "timeout") {
    return Math.min(
      5 * 60 * 1000, // 5 min max
      30 * 1000 * 2 ** Math.min(normalized - 1, 4),
    );
  }

  // Rate limit / other: gentler 2^n backoff with jitter (was 5^n)
  const base = Math.min(
    15 * 60 * 1000, // 15 min max (was 1 hour)
    60 * 1000 * 2 ** Math.min(normalized - 1, 4),
  );
  const jitter = base * (0.1 + Math.random() * 0.1);
  return Math.floor(base + jitter);
}

type ResolvedAuthCooldownConfig = {
  billingBackoffMs: number;
  billingMaxMs: number;
  failureWindowMs: number;
};

function resolveAuthCooldownConfig(params: {
  cfg?: OpenClawConfig;
  providerId: string;
}): ResolvedAuthCooldownConfig {
  const defaults = {
    billingBackoffHours: 5,
    billingMaxHours: 24,
    failureWindowHours: 24,
  } as const;

  const resolveHours = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

  const cooldowns = params.cfg?.auth?.cooldowns;
  const billingOverride = (() => {
    const map = cooldowns?.billingBackoffHoursByProvider;
    if (!map) {
      return undefined;
    }
    for (const [key, value] of Object.entries(map)) {
      if (normalizeProviderId(key) === params.providerId) {
        return value;
      }
    }
    return undefined;
  })();

  const billingBackoffHours = resolveHours(
    billingOverride ?? cooldowns?.billingBackoffHours,
    defaults.billingBackoffHours,
  );
  const billingMaxHours = resolveHours(cooldowns?.billingMaxHours, defaults.billingMaxHours);
  const failureWindowHours = resolveHours(
    cooldowns?.failureWindowHours,
    defaults.failureWindowHours,
  );

  return {
    billingBackoffMs: billingBackoffHours * 60 * 60 * 1000,
    billingMaxMs: billingMaxHours * 60 * 60 * 1000,
    failureWindowMs: failureWindowHours * 60 * 60 * 1000,
  };
}

function calculateAuthProfileBillingDisableMsWithConfig(params: {
  errorCount: number;
  baseMs: number;
  maxMs: number;
}): number {
  const normalized = Math.max(1, params.errorCount);
  const baseMs = Math.max(60_000, params.baseMs);
  const maxMs = Math.max(baseMs, params.maxMs);
  const exponent = Math.min(normalized - 1, 10);
  const raw = baseMs * 2 ** exponent;
  return Math.min(maxMs, raw);
}

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

function computeNextProfileUsageStats(params: {
  existing: ProfileUsageStats;
  now: number;
  reason: AuthProfileFailureReason;
  cfgResolved: ResolvedAuthCooldownConfig;
  model?: string;
  /** Server-provided Retry-After delay (ms). When available, used instead of calculated backoff. */
  retryAfterMs?: number;
}): ProfileUsageStats {
  const windowMs = params.cfgResolved.failureWindowMs;
  const windowExpired =
    typeof params.existing.lastFailureAt === "number" &&
    params.existing.lastFailureAt > 0 &&
    params.now - params.existing.lastFailureAt > windowMs;

  const baseErrorCount = windowExpired ? 0 : (params.existing.errorCount ?? 0);
  const nextErrorCount = baseErrorCount + 1;
  const failureCounts = windowExpired ? {} : { ...params.existing.failureCounts };
  failureCounts[params.reason] = (failureCounts[params.reason] ?? 0) + 1;

  const updatedStats: ProfileUsageStats = {
    ...params.existing,
    errorCount: nextErrorCount,
    failureCounts,
    lastFailureAt: params.now,
  };

  if (params.reason === "billing" || params.reason === "auth_permanent") {
    const billingCount = failureCounts[params.reason] ?? 1;
    const backoffMs = calculateAuthProfileBillingDisableMsWithConfig({
      errorCount: billingCount,
      baseMs: params.cfgResolved.billingBackoffMs,
      maxMs: params.cfgResolved.billingMaxMs,
    });
    // Keep active disable windows immutable so retries within the window cannot
    // extend recovery time indefinitely.
    updatedStats.disabledUntil = keepActiveWindowOrRecompute({
      existingUntil: params.existing.disabledUntil,
      now: params.now,
      recomputedUntil: params.now + backoffMs,
    });
    updatedStats.disabledReason = params.reason;
  } else {
    // Compute backoff: prefer server-provided Retry-After, then calculated.
    let backoffMs: number;
    if (params.retryAfterMs && params.retryAfterMs > 0) {
      // Cap server-provided value at 15 min to avoid pathologically long waits.
      backoffMs = Math.min(params.retryAfterMs, 15 * 60 * 1000);
    } else if (params.reason === "timeout") {
      const timeoutCount = failureCounts.timeout ?? 1;
      backoffMs = calculateAuthProfileCooldownMs(timeoutCount, "timeout");
    } else {
      backoffMs = calculateAuthProfileCooldownMs(nextErrorCount, params.reason);
    }

    if (params.model) {
      // Record per-model cooldown instead of global profile cooldown.
      const existingMc = updatedStats.modelCooldowns ?? {};
      const prevEntry = existingMc[params.model] ?? {};
      const recomputedUntil = params.now + backoffMs;
      existingMc[params.model] = {
        cooldownUntil: keepActiveWindowOrRecompute({
          existingUntil: prevEntry.cooldownUntil,
          now: params.now,
          recomputedUntil,
        }),
        errorCount: (prevEntry.errorCount ?? 0) + 1,
        lastFailureAt: params.now,
      };
      updatedStats.modelCooldowns = existingMc;
    } else {
      // Keep active cooldown windows immutable so retries within the window
      // cannot push recovery further out.
      updatedStats.cooldownUntil = keepActiveWindowOrRecompute({
        existingUntil: params.existing.cooldownUntil,
        now: params.now,
        recomputedUntil: params.now + backoffMs,
      });
    }
  }

  return updatedStats;
}

/**
 * Mark a profile as failed for a specific reason. Billing and permanent-auth
 * failures are treated as "disabled" (longer backoff) vs the regular cooldown
 * window.
 */
export async function markAuthProfileFailure(params: {
  store: AuthProfileStore;
  profileId: string;
  reason: AuthProfileFailureReason;
  cfg?: OpenClawConfig;
  agentDir?: string;
  /** When set, cooldown is recorded per-model instead of globally on the profile. */
  model?: string;
  /** Server-provided Retry-After delay (ms). Overrides calculated backoff when present. */
  retryAfterMs?: number;
}): Promise<void> {
  const { store, profileId, reason, agentDir, cfg, model, retryAfterMs } = params;
  const profile = store.profiles[profileId];
  if (!profile || isAuthCooldownBypassedForProvider(profile.provider)) {
    return;
  }
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      const profile = freshStore.profiles[profileId];
      if (!profile || isAuthCooldownBypassedForProvider(profile.provider)) {
        return false;
      }
      freshStore.usageStats = freshStore.usageStats ?? {};
      const existing = freshStore.usageStats[profileId] ?? {};

      const now = Date.now();
      const providerKey = normalizeProviderId(profile.provider);
      const cfgResolved = resolveAuthCooldownConfig({
        cfg,
        providerId: providerKey,
      });

      freshStore.usageStats[profileId] = computeNextProfileUsageStats({
        existing,
        now,
        reason,
        cfgResolved,
        model,
        retryAfterMs,
      });
      return true;
    },
  });
  if (updated) {
    store.usageStats = updated.usageStats;
    return;
  }
  if (!store.profiles[profileId]) {
    return;
  }

  store.usageStats = store.usageStats ?? {};
  const existing = store.usageStats[profileId] ?? {};
  const now = Date.now();
  const providerKey = normalizeProviderId(store.profiles[profileId]?.provider ?? "");
  const cfgResolved = resolveAuthCooldownConfig({
    cfg,
    providerId: providerKey,
  });

  store.usageStats[profileId] = computeNextProfileUsageStats({
    existing,
    now,
    reason,
    cfgResolved,
    model,
    retryAfterMs,
  });
  saveAuthProfileStore(store, agentDir);
}

/**
 * Mark a profile as failed/rate-limited. Applies exponential backoff cooldown.
 * Cooldown times: 1min, 2min, 4min, 8min, max 15 min.
 * Uses store lock to avoid overwriting concurrent usage updates.
 */
export async function markAuthProfileCooldown(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
}): Promise<void> {
  await markAuthProfileFailure({
    store: params.store,
    profileId: params.profileId,
    reason: "unknown",
    agentDir: params.agentDir,
  });
}

/**
 * Clear cooldown for a profile (e.g., manual reset).
 * Uses store lock to avoid overwriting concurrent usage updates.
 */
export async function clearAuthProfileCooldown(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
}): Promise<void> {
  const { store, profileId, agentDir } = params;
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      if (!freshStore.usageStats?.[profileId]) {
        return false;
      }

      freshStore.usageStats[profileId] = {
        ...freshStore.usageStats[profileId],
        errorCount: 0,
        cooldownUntil: undefined,
        modelCooldowns: undefined,
        disabledUntil: undefined,
        disabledReason: undefined,
        failureCounts: undefined,
      };
      return true;
    },
  });
  if (updated) {
    store.usageStats = updated.usageStats;
    return;
  }
  if (!store.usageStats?.[profileId]) {
    return;
  }

  store.usageStats[profileId] = {
    ...store.usageStats[profileId],
    errorCount: 0,
    cooldownUntil: undefined,
    modelCooldowns: undefined,
    disabledUntil: undefined,
    disabledReason: undefined,
    failureCounts: undefined,
  };
  saveAuthProfileStore(store, agentDir);
}

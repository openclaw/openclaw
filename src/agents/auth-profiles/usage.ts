import type { OpenClawConfig } from "../../config/config.js";
import type { AuthProfileFailureReason, AuthProfileStore, ProfileUsageStats } from "./types.js";
import { normalizeProviderId } from "../model-selection.js";
import { saveAuthProfileStore, updateAuthProfileStoreWithLock } from "./store.js";

function resolveProfileUnusableUntil(stats: ProfileUsageStats): number | null {
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
 * If `model` is provided, also checks model-specific cooldowns.
 * A profile is considered in cooldown if:
 * - Profile-level cooldown is active (auth/billing errors), OR
 * - The specific model has an active cooldown (rate_limit errors)
 */
export function isProfileInCooldown(
  store: AuthProfileStore,
  profileId: string,
  model?: string,
): boolean {
  const stats = store.usageStats?.[profileId];
  if (!stats) {
    return false;
  }
  // Check profile-level cooldown (auth/billing errors disable entire profile)
  const profileUnusableUntil = resolveProfileUnusableUntil(stats);
  if (profileUnusableUntil && Date.now() < profileUnusableUntil) {
    return true;
  }
  // Check model-specific cooldown if model is provided
  if (model && stats.modelCooldowns) {
    const modelCooldownUntil = stats.modelCooldowns[model];
    if (
      typeof modelCooldownUntil === "number" &&
      Number.isFinite(modelCooldownUntil) &&
      modelCooldownUntil > 0 &&
      Date.now() < modelCooldownUntil
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Mark a profile as successfully used. Resets error count and updates lastUsed.
 * Uses store lock to avoid overwriting concurrent usage updates.
 *
 * If `model` is provided, only clears the cooldown for that specific model.
 * If `model` is not provided, clears all cooldowns (profile-level and model-level).
 */
export async function markAuthProfileUsed(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
  /** Optional model ID - if provided, only clears cooldown for this model */
  model?: string;
}): Promise<void> {
  const { store, profileId, agentDir, model } = params;
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      if (!freshStore.profiles[profileId]) {
        return false;
      }
      freshStore.usageStats = freshStore.usageStats ?? {};
      const existing = freshStore.usageStats[profileId] ?? {};

      if (model) {
        // Only clear cooldown for the specific model
        const modelCooldowns = { ...existing.modelCooldowns };
        const modelErrorCounts = { ...existing.modelErrorCounts };
        const modelLastFailureAt = { ...existing.modelLastFailureAt };
        delete modelCooldowns[model];
        delete modelErrorCounts[model];
        delete modelLastFailureAt[model];

        freshStore.usageStats[profileId] = {
          ...existing,
          lastUsed: Date.now(),
          modelCooldowns: Object.keys(modelCooldowns).length > 0 ? modelCooldowns : undefined,
          modelErrorCounts: Object.keys(modelErrorCounts).length > 0 ? modelErrorCounts : undefined,
          modelLastFailureAt:
            Object.keys(modelLastFailureAt).length > 0 ? modelLastFailureAt : undefined,
        };
      } else {
        // Clear all cooldowns
        freshStore.usageStats[profileId] = {
          ...existing,
          lastUsed: Date.now(),
          errorCount: 0,
          cooldownUntil: undefined,
          disabledUntil: undefined,
          disabledReason: undefined,
          failureCounts: undefined,
          modelCooldowns: undefined,
          modelErrorCounts: undefined,
          modelLastFailureAt: undefined,
        };
      }
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

  if (model) {
    // Only clear cooldown for the specific model
    const modelCooldowns = { ...existing.modelCooldowns };
    const modelErrorCounts = { ...existing.modelErrorCounts };
    const modelLastFailureAt = { ...existing.modelLastFailureAt };
    delete modelCooldowns[model];
    delete modelErrorCounts[model];
    delete modelLastFailureAt[model];

    store.usageStats[profileId] = {
      ...existing,
      lastUsed: Date.now(),
      modelCooldowns: Object.keys(modelCooldowns).length > 0 ? modelCooldowns : undefined,
      modelErrorCounts: Object.keys(modelErrorCounts).length > 0 ? modelErrorCounts : undefined,
      modelLastFailureAt:
        Object.keys(modelLastFailureAt).length > 0 ? modelLastFailureAt : undefined,
    };
  } else {
    // Clear all cooldowns
    store.usageStats[profileId] = {
      ...existing,
      lastUsed: Date.now(),
      errorCount: 0,
      cooldownUntil: undefined,
      disabledUntil: undefined,
      disabledReason: undefined,
      failureCounts: undefined,
      modelCooldowns: undefined,
      modelErrorCounts: undefined,
      modelLastFailureAt: undefined,
    };
  }
  saveAuthProfileStore(store, agentDir);
}

export function calculateAuthProfileCooldownMs(errorCount: number): number {
  const normalized = Math.max(1, errorCount);
  return Math.min(
    60 * 60 * 1000, // 1 hour max
    60 * 1000 * 5 ** Math.min(normalized - 1, 3),
  );
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
  const stats = store.usageStats?.[profileId];
  if (!stats) {
    return null;
  }
  return resolveProfileUnusableUntil(stats);
}

/**
 * Get the cooldown expiry timestamp for a specific model on a profile.
 * Returns null if no model-specific cooldown is active.
 */
export function getModelCooldownUntil(
  store: AuthProfileStore,
  profileId: string,
  model: string,
): number | null {
  const stats = store.usageStats?.[profileId];
  if (!stats?.modelCooldowns) {
    return null;
  }
  const cooldownUntil = stats.modelCooldowns[model];
  if (
    typeof cooldownUntil === "number" &&
    Number.isFinite(cooldownUntil) &&
    cooldownUntil > 0 &&
    Date.now() < cooldownUntil
  ) {
    return cooldownUntil;
  }
  return null;
}

/**
 * Check if a profile is in cooldown for a specific model.
 * This is a convenience wrapper that combines profile-level and model-level checks.
 */
export function isProfileInCooldownForModel(
  store: AuthProfileStore,
  profileId: string,
  model: string,
): boolean {
  return isProfileInCooldown(store, profileId, model);
}

function computeNextProfileUsageStats(params: {
  existing: ProfileUsageStats;
  now: number;
  reason: AuthProfileFailureReason;
  cfgResolved: ResolvedAuthCooldownConfig;
  /** Optional model ID for model-specific rate_limit cooldowns */
  model?: string;
}): ProfileUsageStats {
  const windowMs = params.cfgResolved.failureWindowMs;

  // For rate_limit errors with a specific model, use model-level tracking
  if (params.reason === "rate_limit" && params.model) {
    const modelLastFailureAt = params.existing.modelLastFailureAt?.[params.model];
    const modelWindowExpired =
      typeof modelLastFailureAt === "number" &&
      modelLastFailureAt > 0 &&
      params.now - modelLastFailureAt > windowMs;

    const baseModelErrorCount = modelWindowExpired
      ? 0
      : (params.existing.modelErrorCounts?.[params.model] ?? 0);
    const nextModelErrorCount = baseModelErrorCount + 1;
    const backoffMs = calculateAuthProfileCooldownMs(nextModelErrorCount);

    const updatedStats: ProfileUsageStats = {
      ...params.existing,
      modelCooldowns: {
        ...params.existing.modelCooldowns,
        [params.model]: params.now + backoffMs,
      },
      modelErrorCounts: {
        ...params.existing.modelErrorCounts,
        [params.model]: nextModelErrorCount,
      },
      modelLastFailureAt: {
        ...params.existing.modelLastFailureAt,
        [params.model]: params.now,
      },
    };
    return updatedStats;
  }

  // For non-rate_limit errors or rate_limit without model, use profile-level tracking
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

  if (params.reason === "billing") {
    const billingCount = failureCounts.billing ?? 1;
    const backoffMs = calculateAuthProfileBillingDisableMsWithConfig({
      errorCount: billingCount,
      baseMs: params.cfgResolved.billingBackoffMs,
      maxMs: params.cfgResolved.billingMaxMs,
    });
    updatedStats.disabledUntil = params.now + backoffMs;
    updatedStats.disabledReason = "billing";
  } else {
    // For rate_limit without model info, or auth/format/timeout/unknown errors,
    // apply profile-level cooldown
    const backoffMs = calculateAuthProfileCooldownMs(nextErrorCount);
    updatedStats.cooldownUntil = params.now + backoffMs;
  }

  return updatedStats;
}

/**
 * Mark a profile as failed for a specific reason. Billing failures are treated
 * as "disabled" (longer backoff) vs the regular cooldown window.
 *
 * For rate_limit errors, if `model` is provided, the cooldown is applied to that
 * specific model only, allowing other models on the same profile to remain usable.
 * Auth, billing, and other errors always apply profile-wide cooldowns.
 */
export async function markAuthProfileFailure(params: {
  store: AuthProfileStore;
  profileId: string;
  reason: AuthProfileFailureReason;
  cfg?: OpenClawConfig;
  agentDir?: string;
  /** Optional model ID for model-specific rate_limit cooldowns */
  model?: string;
}): Promise<void> {
  const { store, profileId, reason, agentDir, cfg, model } = params;
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      const profile = freshStore.profiles[profileId];
      if (!profile) {
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
  });
  saveAuthProfileStore(store, agentDir);
}

/**
 * Mark a profile as failed/rate-limited. Applies exponential backoff cooldown.
 * Cooldown times: 1min, 5min, 25min, max 1 hour.
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
 *
 * If `model` is provided, only clears the cooldown for that specific model.
 * If `model` is not provided, clears all cooldowns (profile-level and model-level).
 */
export async function clearAuthProfileCooldown(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
  /** Optional model ID - if provided, only clears cooldown for this model */
  model?: string;
}): Promise<void> {
  const { store, profileId, agentDir, model } = params;
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      if (!freshStore.usageStats?.[profileId]) {
        return false;
      }

      const existing = freshStore.usageStats[profileId];
      if (model) {
        // Only clear cooldown for the specific model
        const modelCooldowns = { ...existing.modelCooldowns };
        const modelErrorCounts = { ...existing.modelErrorCounts };
        delete modelCooldowns[model];
        delete modelErrorCounts[model];

        freshStore.usageStats[profileId] = {
          ...existing,
          modelCooldowns: Object.keys(modelCooldowns).length > 0 ? modelCooldowns : undefined,
          modelErrorCounts: Object.keys(modelErrorCounts).length > 0 ? modelErrorCounts : undefined,
        };
      } else {
        // Clear all cooldowns
        freshStore.usageStats[profileId] = {
          ...existing,
          errorCount: 0,
          cooldownUntil: undefined,
          modelCooldowns: undefined,
          modelErrorCounts: undefined,
          modelLastFailureAt: undefined,
        };
      }
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

  const existing = store.usageStats[profileId];
  if (model) {
    // Only clear cooldown for the specific model
    const modelCooldowns = { ...existing.modelCooldowns };
    const modelErrorCounts = { ...existing.modelErrorCounts };
    delete modelCooldowns[model];
    delete modelErrorCounts[model];

    store.usageStats[profileId] = {
      ...existing,
      modelCooldowns: Object.keys(modelCooldowns).length > 0 ? modelCooldowns : undefined,
      modelErrorCounts: Object.keys(modelErrorCounts).length > 0 ? modelErrorCounts : undefined,
    };
  } else {
    // Clear all cooldowns
    store.usageStats[profileId] = {
      ...existing,
      errorCount: 0,
      cooldownUntil: undefined,
      modelCooldowns: undefined,
      modelErrorCounts: undefined,
      modelLastFailureAt: undefined,
    };
  }
  saveAuthProfileStore(store, agentDir);
}

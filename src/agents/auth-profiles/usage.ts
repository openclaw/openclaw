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
 * When modelId is provided, checks model-specific cooldown first (for rate limits),
 * then falls back to provider-level cooldown (for auth/billing failures).
 */
export function isProfileInCooldown(
  store: AuthProfileStore,
  profileId: string,
  modelId?: string,
): boolean {
  const stats = store.usageStats?.[profileId];
  if (!stats) {
    return false;
  }

  // Check model-specific cooldown first (for rate_limit errors)
  if (modelId) {
    const modelStats = stats.modelCooldowns?.[modelId];
    if (modelStats?.cooldownUntil && Date.now() < modelStats.cooldownUntil) {
      return true;
    }
    // Auth/format failures set provider-level cooldown and should block ALL models
    if (stats.cooldownUntil && Date.now() < stats.cooldownUntil) {
      return true;
    }
    // Billing/disabled state also blocks all models
    if (stats.disabledUntil && Date.now() < stats.disabledUntil) {
      return true;
    }
    // Model-specific check passed - allow this model even if other models caused rate_limit cooldown
    return false;
  }

  // No model specified - use legacy provider-level check
  const unusableUntil = resolveProfileUnusableUntil(stats);
  return unusableUntil ? Date.now() < unusableUntil : false;
}

/**
 * Mark a profile as successfully used. Resets error count and updates lastUsed.
 * When modelId is provided, clears only that model's cooldown while preserving
 * other model cooldowns.
 * Uses store lock to avoid overwriting concurrent usage updates.
 */
export async function markAuthProfileUsed(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
  /** Optional model ID - when provided, only clears cooldown for that specific model */
  modelId?: string;
}): Promise<void> {
  const { store, profileId, agentDir, modelId } = params;
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      if (!freshStore.profiles[profileId]) {
        return false;
      }
      freshStore.usageStats = freshStore.usageStats ?? {};
      const existing = freshStore.usageStats[profileId] ?? {};

      if (modelId) {
        // Clear the specific model's cooldown and provider-level cooldown
        // (successful use proves auth is working)
        const modelCooldowns = { ...existing.modelCooldowns };
        delete modelCooldowns[modelId];
        freshStore.usageStats[profileId] = {
          ...existing,
          lastUsed: Date.now(),
          errorCount: 0,
          cooldownUntil: undefined,
          modelCooldowns: Object.keys(modelCooldowns).length > 0 ? modelCooldowns : undefined,
        };
      } else {
        // Clear all cooldowns (legacy behavior)
        freshStore.usageStats[profileId] = {
          ...existing,
          lastUsed: Date.now(),
          errorCount: 0,
          cooldownUntil: undefined,
          disabledUntil: undefined,
          disabledReason: undefined,
          failureCounts: undefined,
          modelCooldowns: undefined,
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

  if (modelId) {
    // Clear the specific model's cooldown and provider-level cooldown
    // (successful use proves auth is working)
    const modelCooldowns = { ...existing.modelCooldowns };
    delete modelCooldowns[modelId];
    store.usageStats[profileId] = {
      ...existing,
      lastUsed: Date.now(),
      errorCount: 0,
      cooldownUntil: undefined,
      modelCooldowns: Object.keys(modelCooldowns).length > 0 ? modelCooldowns : undefined,
    };
  } else {
    // Clear all cooldowns (legacy behavior)
    store.usageStats[profileId] = {
      ...existing,
      lastUsed: Date.now(),
      errorCount: 0,
      cooldownUntil: undefined,
      disabledUntil: undefined,
      disabledReason: undefined,
      failureCounts: undefined,
      modelCooldowns: undefined,
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

function computeNextProfileUsageStats(params: {
  existing: ProfileUsageStats;
  now: number;
  reason: AuthProfileFailureReason;
  cfgResolved: ResolvedAuthCooldownConfig;
  modelId?: string;
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
    modelCooldowns: { ...params.existing.modelCooldowns },
  };

  // Helper to apply model-specific cooldown
  const applyModelCooldown = (modelId: string) => {
    const existingModelStats = params.existing.modelCooldowns?.[modelId] ?? {};
    const modelWindowExpired =
      typeof existingModelStats.lastFailureAt === "number" &&
      existingModelStats.lastFailureAt > 0 &&
      params.now - existingModelStats.lastFailureAt > windowMs;

    const modelErrorCount = modelWindowExpired ? 1 : (existingModelStats.errorCount ?? 0) + 1;
    const backoffMs = calculateAuthProfileCooldownMs(modelErrorCount);

    updatedStats.modelCooldowns = updatedStats.modelCooldowns ?? {};
    updatedStats.modelCooldowns[modelId] = {
      cooldownUntil: params.now + backoffMs,
      errorCount: modelErrorCount,
      lastFailureAt: params.now,
    };
  };

  if (params.reason === "billing") {
    // Billing failures affect the entire provider
    const billingCount = failureCounts.billing ?? 1;
    const backoffMs = calculateAuthProfileBillingDisableMsWithConfig({
      errorCount: billingCount,
      baseMs: params.cfgResolved.billingBackoffMs,
      maxMs: params.cfgResolved.billingMaxMs,
    });
    updatedStats.disabledUntil = params.now + backoffMs;
    updatedStats.disabledReason = "billing";
  } else if (params.reason === "rate_limit" && params.modelId) {
    // Rate limit errors are tracked per-model when modelId is provided
    applyModelCooldown(params.modelId);
  } else if (params.reason === "auth" || params.reason === "format") {
    // Auth/format failures affect the entire provider
    const backoffMs = calculateAuthProfileCooldownMs(nextErrorCount);
    updatedStats.cooldownUntil = params.now + backoffMs;
  } else {
    // Other failures (timeout, unknown) - model-specific if modelId provided, else provider-level
    if (params.modelId) {
      applyModelCooldown(params.modelId);
    } else {
      const backoffMs = calculateAuthProfileCooldownMs(nextErrorCount);
      updatedStats.cooldownUntil = params.now + backoffMs;
    }
  }

  return updatedStats;
}

/**
 * Mark a profile as failed for a specific reason. Billing failures are treated
 * as "disabled" (longer backoff) vs the regular cooldown window.
 * When modelId is provided and reason is rate_limit, tracks cooldown per-model
 * instead of per-provider, allowing other models from the same provider to continue working.
 */
export async function markAuthProfileFailure(params: {
  store: AuthProfileStore;
  profileId: string;
  reason: AuthProfileFailureReason;
  cfg?: OpenClawConfig;
  agentDir?: string;
  /** Optional model ID for per-model cooldown tracking (used for rate_limit errors) */
  modelId?: string;
}): Promise<void> {
  const { store, profileId, reason, agentDir, cfg, modelId } = params;
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
        modelId,
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
    modelId,
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
 * Clears both provider-level and per-model cooldowns.
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
  };
  saveAuthProfileStore(store, agentDir);
}

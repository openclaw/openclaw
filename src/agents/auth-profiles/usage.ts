import type { OpenClawConfig } from "../../config/config.js";
import type {
  AuthProfileFailureReason,
  AuthProfileStore,
  ModelCooldownStats,
  ProfileUsageStats,
} from "./types.js";
import { normalizeProviderId } from "../model-selection.js";
import { saveAuthProfileStore, updateAuthProfileStoreWithLock } from "./store.js";
import { isModelScopedFailure } from "./types.js";

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
 * When modelId is provided, checks model-specific cooldown in addition to profile-level.
 * Profile-level cooldown (billing, auth) always takes precedence.
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

  // Profile-level cooldown always applies (billing, auth, etc.)
  const profileUnusable = resolveProfileUnusableUntil(stats);
  if (profileUnusable && Date.now() < profileUnusable) {
    return true;
  }

  // If a specific model is requested, check model-level cooldown
  if (modelId) {
    const modelStats = stats.modelCooldowns?.[modelId];
    if (modelStats?.cooldownUntil && Date.now() < modelStats.cooldownUntil) {
      return true;
    }
  }

  return false;
}

/**
 * Mark a profile as successfully used. Resets error count and updates lastUsed.
 * Uses store lock to avoid overwriting concurrent usage updates.
 */
export async function markAuthProfileUsed(params: {
  store: AuthProfileStore;
  profileId: string;
  modelId?: string;
  agentDir?: string;
}): Promise<void> {
  const { store, profileId, modelId, agentDir } = params;
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      if (!freshStore.profiles[profileId]) {
        return false;
      }
      freshStore.usageStats = freshStore.usageStats ?? {};
      const existing = freshStore.usageStats[profileId] ?? {};

      // Clear model-specific cooldown on success
      let modelCooldowns = existing.modelCooldowns;
      if (modelId && modelCooldowns?.[modelId]) {
        modelCooldowns = { ...modelCooldowns };
        delete modelCooldowns[modelId];
        if (Object.keys(modelCooldowns).length === 0) {
          modelCooldowns = undefined;
        }
      }

      freshStore.usageStats[profileId] = {
        ...existing,
        lastUsed: Date.now(),
        errorCount: 0,
        cooldownUntil: undefined,
        disabledUntil: undefined,
        disabledReason: undefined,
        failureCounts: undefined,
        modelCooldowns,
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
  const existing = store.usageStats[profileId] ?? {};

  let modelCooldowns = existing.modelCooldowns;
  if (modelId && modelCooldowns?.[modelId]) {
    modelCooldowns = { ...modelCooldowns };
    delete modelCooldowns[modelId];
    if (Object.keys(modelCooldowns).length === 0) {
      modelCooldowns = undefined;
    }
  }

  store.usageStats[profileId] = {
    ...existing,
    lastUsed: Date.now(),
    errorCount: 0,
    cooldownUntil: undefined,
    disabledUntil: undefined,
    disabledReason: undefined,
    failureCounts: undefined,
    modelCooldowns,
  };
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
    const backoffMs = calculateAuthProfileCooldownMs(nextErrorCount);
    updatedStats.cooldownUntil = params.now + backoffMs;
  }

  return updatedStats;
}

/**
 * Compute the next model-level cooldown stats for a rate-limited model.
 */
function computeNextModelCooldownStats(params: {
  existing: ModelCooldownStats;
  now: number;
  failureWindowMs: number;
}): ModelCooldownStats {
  const windowExpired =
    typeof params.existing.lastFailureAt === "number" &&
    params.existing.lastFailureAt > 0 &&
    params.now - params.existing.lastFailureAt > params.failureWindowMs;

  const baseErrorCount = windowExpired ? 0 : (params.existing.errorCount ?? 0);
  const nextErrorCount = baseErrorCount + 1;
  const backoffMs = calculateAuthProfileCooldownMs(nextErrorCount);

  return {
    cooldownUntil: params.now + backoffMs,
    errorCount: nextErrorCount,
    lastFailureAt: params.now,
  };
}

/**
 * Mark a profile as failed for a specific reason. Billing failures are treated
 * as "disabled" (longer backoff) vs the regular cooldown window.
 *
 * When modelId is provided and the failure is model-scoped (rate_limit),
 * the cooldown is tracked per-model instead of per-profile, allowing other
 * models on the same provider to remain available.
 */
export async function markAuthProfileFailure(params: {
  store: AuthProfileStore;
  profileId: string;
  reason: AuthProfileFailureReason;
  modelId?: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
}): Promise<void> {
  const { store, profileId, reason, modelId, agentDir, cfg } = params;
  const useModelScope = modelId && isModelScopedFailure(reason);

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
      const cfgResolved = resolveAuthCooldownConfig({ cfg, providerId: providerKey });

      if (useModelScope) {
        // Per-model cooldown for rate_limit
        const modelCooldowns = { ...existing.modelCooldowns };
        modelCooldowns[modelId] = computeNextModelCooldownStats({
          existing: modelCooldowns[modelId] ?? {},
          now,
          failureWindowMs: cfgResolved.failureWindowMs,
        });
        freshStore.usageStats[profileId] = { ...existing, modelCooldowns };
      } else {
        // Profile-level cooldown (existing behavior)
        freshStore.usageStats[profileId] = computeNextProfileUsageStats({
          existing,
          now,
          reason,
          cfgResolved,
        });
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
  const now = Date.now();
  const providerKey = normalizeProviderId(store.profiles[profileId]?.provider ?? "");
  const cfgResolved = resolveAuthCooldownConfig({ cfg, providerId: providerKey });

  if (useModelScope) {
    const modelCooldowns = { ...existing.modelCooldowns };
    modelCooldowns[modelId] = computeNextModelCooldownStats({
      existing: modelCooldowns[modelId] ?? {},
      now,
      failureWindowMs: cfgResolved.failureWindowMs,
    });
    store.usageStats[profileId] = { ...existing, modelCooldowns };
  } else {
    store.usageStats[profileId] = computeNextProfileUsageStats({
      existing,
      now,
      reason,
      cfgResolved,
    });
  }
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

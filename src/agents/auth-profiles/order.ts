import type { OpenClawConfig } from "../../config/config.js";
import type { AuthProfileStore } from "./types.js";
import { normalizeProviderId } from "../model-selection.js";
import { listProfilesForProvider } from "./profiles.js";
import { isProfileInCooldown } from "./usage.js";

/**
 * Resolve when a profile becomes usable for a specific model.
 * Considers both profile-level cooldowns (auth/billing) and model-specific cooldowns (rate_limit).
 */
function resolveProfileUnusableUntilForModel(
  stats: {
    cooldownUntil?: number;
    disabledUntil?: number;
    modelCooldowns?: Record<string, number>;
  },
  model?: string,
): number | null {
  // Collect all applicable cooldown timestamps
  const values: number[] = [];

  // Profile-level cooldowns (auth/billing errors)
  if (
    typeof stats.cooldownUntil === "number" &&
    Number.isFinite(stats.cooldownUntil) &&
    stats.cooldownUntil > 0
  ) {
    values.push(stats.cooldownUntil);
  }
  if (
    typeof stats.disabledUntil === "number" &&
    Number.isFinite(stats.disabledUntil) &&
    stats.disabledUntil > 0
  ) {
    values.push(stats.disabledUntil);
  }

  // Model-specific cooldown (rate_limit errors)
  if (model && stats.modelCooldowns) {
    const modelCooldown = stats.modelCooldowns[model];
    if (typeof modelCooldown === "number" && Number.isFinite(modelCooldown) && modelCooldown > 0) {
      values.push(modelCooldown);
    }
  }

  if (values.length === 0) {
    return null;
  }
  return Math.max(...values);
}

export function resolveAuthProfileOrder(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  preferredProfile?: string;
  /** Optional model ID for model-specific cooldown checks */
  model?: string;
}): string[] {
  const { cfg, store, provider, preferredProfile, model } = params;
  const providerKey = normalizeProviderId(provider);
  const now = Date.now();
  const storedOrder = (() => {
    const order = store.order;
    if (!order) {
      return undefined;
    }
    for (const [key, value] of Object.entries(order)) {
      if (normalizeProviderId(key) === providerKey) {
        return value;
      }
    }
    return undefined;
  })();
  const configuredOrder = (() => {
    const order = cfg?.auth?.order;
    if (!order) {
      return undefined;
    }
    for (const [key, value] of Object.entries(order)) {
      if (normalizeProviderId(key) === providerKey) {
        return value;
      }
    }
    return undefined;
  })();
  const explicitOrder = storedOrder ?? configuredOrder;
  const explicitProfiles = cfg?.auth?.profiles
    ? Object.entries(cfg.auth.profiles)
        .filter(([, profile]) => normalizeProviderId(profile.provider) === providerKey)
        .map(([profileId]) => profileId)
    : [];
  const baseOrder =
    explicitOrder ??
    (explicitProfiles.length > 0 ? explicitProfiles : listProfilesForProvider(store, providerKey));
  if (baseOrder.length === 0) {
    return [];
  }

  const filtered = baseOrder.filter((profileId) => {
    const cred = store.profiles[profileId];
    if (!cred) {
      return false;
    }
    if (normalizeProviderId(cred.provider) !== providerKey) {
      return false;
    }
    const profileConfig = cfg?.auth?.profiles?.[profileId];
    if (profileConfig) {
      if (normalizeProviderId(profileConfig.provider) !== providerKey) {
        return false;
      }
      if (profileConfig.mode !== cred.type) {
        const oauthCompatible = profileConfig.mode === "oauth" && cred.type === "token";
        if (!oauthCompatible) {
          return false;
        }
      }
    }
    if (cred.type === "api_key") {
      return Boolean(cred.key?.trim());
    }
    if (cred.type === "token") {
      if (!cred.token?.trim()) {
        return false;
      }
      if (
        typeof cred.expires === "number" &&
        Number.isFinite(cred.expires) &&
        cred.expires > 0 &&
        now >= cred.expires
      ) {
        return false;
      }
      return true;
    }
    if (cred.type === "oauth") {
      return Boolean(cred.access?.trim() || cred.refresh?.trim());
    }
    return false;
  });
  const deduped: string[] = [];
  for (const entry of filtered) {
    if (!deduped.includes(entry)) {
      deduped.push(entry);
    }
  }

  // If user specified explicit order (store override or config), respect it
  // exactly, but still apply cooldown sorting to avoid repeatedly selecting
  // known-bad/rate-limited keys as the first candidate.
  if (explicitOrder && explicitOrder.length > 0) {
    // ...but still respect cooldown tracking to avoid repeatedly selecting a
    // known-bad/rate-limited key as the first candidate.
    // Use model-aware cooldown check if model is provided
    const available: string[] = [];
    const inCooldown: Array<{ profileId: string; cooldownUntil: number }> = [];

    for (const profileId of deduped) {
      const cooldownUntil =
        resolveProfileUnusableUntilForModel(store.usageStats?.[profileId] ?? {}, model) ?? 0;
      if (
        typeof cooldownUntil === "number" &&
        Number.isFinite(cooldownUntil) &&
        cooldownUntil > 0 &&
        now < cooldownUntil
      ) {
        inCooldown.push({ profileId, cooldownUntil });
      } else {
        available.push(profileId);
      }
    }

    const cooldownSorted = inCooldown
      .toSorted((a, b) => a.cooldownUntil - b.cooldownUntil)
      .map((entry) => entry.profileId);

    const ordered = [...available, ...cooldownSorted];

    // Still put preferredProfile first if specified
    if (preferredProfile && ordered.includes(preferredProfile)) {
      return [preferredProfile, ...ordered.filter((e) => e !== preferredProfile)];
    }
    return ordered;
  }

  // Otherwise, use round-robin: sort by lastUsed (oldest first)
  // preferredProfile goes first if specified (for explicit user choice)
  // lastGood is NOT prioritized - that would defeat round-robin
  const sorted = orderProfilesByMode(deduped, store, model);

  if (preferredProfile && sorted.includes(preferredProfile)) {
    return [preferredProfile, ...sorted.filter((e) => e !== preferredProfile)];
  }

  return sorted;
}

function orderProfilesByMode(order: string[], store: AuthProfileStore, model?: string): string[] {
  const now = Date.now();

  // Partition into available and in-cooldown
  // Use model-aware cooldown check if model is provided
  const available: string[] = [];
  const inCooldown: string[] = [];

  for (const profileId of order) {
    if (isProfileInCooldown(store, profileId, model)) {
      inCooldown.push(profileId);
    } else {
      available.push(profileId);
    }
  }

  // Sort available profiles by lastUsed (oldest first = round-robin)
  // Then by lastUsed (oldest first = round-robin within type)
  const scored = available.map((profileId) => {
    const type = store.profiles[profileId]?.type;
    const typeScore = type === "oauth" ? 0 : type === "token" ? 1 : type === "api_key" ? 2 : 3;
    const lastUsed = store.usageStats?.[profileId]?.lastUsed ?? 0;
    return { profileId, typeScore, lastUsed };
  });

  // Primary sort: type preference (oauth > token > api_key).
  // Secondary sort: lastUsed (oldest first for round-robin within type).
  const sorted = scored
    .toSorted((a, b) => {
      // First by type (oauth > token > api_key)
      if (a.typeScore !== b.typeScore) {
        return a.typeScore - b.typeScore;
      }
      // Then by lastUsed (oldest first)
      return a.lastUsed - b.lastUsed;
    })
    .map((entry) => entry.profileId);

  // Append cooldown profiles at the end (sorted by cooldown expiry, soonest first)
  // Use model-aware cooldown expiry if model is provided
  const cooldownSorted = inCooldown
    .map((profileId) => ({
      profileId,
      cooldownUntil:
        resolveProfileUnusableUntilForModel(store.usageStats?.[profileId] ?? {}, model) ?? now,
    }))
    .toSorted((a, b) => a.cooldownUntil - b.cooldownUntil)
    .map((entry) => entry.profileId);

  return [...sorted, ...cooldownSorted];
}

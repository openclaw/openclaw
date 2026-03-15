import { normalizeProviderId } from "../model-selection.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

export type OAuthProfileCleanupResult = {
  changed: boolean;
  removedProfileIds: string[];
  resetProfileIds: string[];
};

function normalizeEmail(raw: string | undefined): string | null {
  const value = raw?.trim().toLowerCase();
  return value ? value : null;
}

function normalizeRefresh(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value ? value : null;
}

function isOAuthCredential(value: unknown): value is OAuthCredential {
  if (!value || typeof value !== "object") {
    return false;
  }
  const typed = value as { type?: string };
  return typed.type === "oauth";
}

function getProfileDedupeKey(profileId: string, credential: OAuthCredential): string | null {
  const provider = normalizeProviderId(credential.provider);
  const email = normalizeEmail(credential.email);
  if (email) {
    return `${provider}::email::${email}`;
  }
  const refresh = normalizeRefresh(credential.refresh);
  if (refresh) {
    return `${provider}::refresh::${refresh}`;
  }
  return null;
}

function getProfileExpiry(credential: OAuthCredential): number {
  const value = credential.expires;
  return typeof value === "number" && Number.isFinite(value) ? value : -1;
}

function selectProfileToKeep(params: {
  profileIds: string[];
  store: AuthProfileStore;
  preferred: Set<string>;
}): string {
  let keep = params.profileIds[0] ?? "";
  let keepScore = Number.NEGATIVE_INFINITY;

  for (const profileId of params.profileIds) {
    const cred = params.store.profiles[profileId];
    if (!isOAuthCredential(cred)) {
      continue;
    }
    const preferredScore = params.preferred.has(profileId) ? 10_000_000_000_000 : 0;
    const defaultScore = profileId.endsWith(":default") ? 1 : 0;
    const expiryScore = getProfileExpiry(cred);
    const score = preferredScore + expiryScore + defaultScore;
    if (score > keepScore || (score === keepScore && profileId.localeCompare(keep) < 0)) {
      keep = profileId;
      keepScore = score;
    }
  }

  return keep;
}

function resetProfileFailureState(store: AuthProfileStore, profileId: string): boolean {
  if (!store.usageStats?.[profileId]) {
    return false;
  }
  store.usageStats[profileId] = {
    ...store.usageStats[profileId],
    errorCount: 0,
    cooldownUntil: undefined,
    disabledUntil: undefined,
    disabledReason: undefined,
    failureCounts: undefined,
    lastFailureAt: undefined,
  };
  return true;
}

function pruneDanglingStoreReferences(store: AuthProfileStore): boolean {
  let changed = false;

  if (store.usageStats) {
    for (const profileId of Object.keys(store.usageStats)) {
      if (store.profiles[profileId]) {
        continue;
      }
      delete store.usageStats[profileId];
      changed = true;
    }
    if (Object.keys(store.usageStats).length === 0) {
      store.usageStats = undefined;
      changed = true;
    }
  }

  if (store.order) {
    for (const provider of Object.keys(store.order)) {
      const existing = store.order[provider] ?? [];
      const filtered = existing.filter((id) => Boolean(store.profiles[id]));
      const deduped = [...new Set(filtered)];
      if (deduped.length > 0) {
        if (deduped.length !== existing.length) {
          store.order[provider] = deduped;
          changed = true;
        }
      } else {
        delete store.order[provider];
        changed = true;
      }
    }
    if (Object.keys(store.order).length === 0) {
      store.order = undefined;
      changed = true;
    }
  }

  if (store.lastGood) {
    for (const [provider, profileId] of Object.entries(store.lastGood)) {
      if (store.profiles[profileId]) {
        continue;
      }
      const providerKey = normalizeProviderId(provider);
      const replacement = Object.entries(store.profiles).find(
        ([, cred]) => normalizeProviderId(cred.provider) === providerKey,
      )?.[0];
      if (replacement) {
        store.lastGood[provider] = replacement;
      } else {
        delete store.lastGood[provider];
      }
      changed = true;
    }
    if (Object.keys(store.lastGood).length === 0) {
      store.lastGood = undefined;
      changed = true;
    }
  }

  return changed;
}

export function cleanupOAuthProfiles(params: {
  store: AuthProfileStore;
  provider?: string;
  keepProfileIds?: string[];
  resetUsageForProfileIds?: string[];
}): OAuthProfileCleanupResult {
  const providerFilter = params.provider ? normalizeProviderId(params.provider) : null;
  const preferred = new Set((params.keepProfileIds ?? []).map((id) => String(id).trim()));
  const resetTargetIds = new Set(
    (params.resetUsageForProfileIds ?? []).map((id) => String(id).trim()).filter(Boolean),
  );
  const groups = new Map<string, string[]>();

  for (const [profileId, credential] of Object.entries(params.store.profiles)) {
    if (!isOAuthCredential(credential)) {
      continue;
    }
    if (providerFilter && normalizeProviderId(credential.provider) !== providerFilter) {
      continue;
    }
    const dedupeKey = getProfileDedupeKey(profileId, credential);
    if (!dedupeKey) {
      continue;
    }
    const existing = groups.get(dedupeKey) ?? [];
    existing.push(profileId);
    groups.set(dedupeKey, existing);
  }

  let changed = false;
  const removedProfileIds: string[] = [];
  const resetProfileIds: string[] = [];

  for (const profileIds of groups.values()) {
    if (profileIds.length <= 1) {
      continue;
    }
    const keep = selectProfileToKeep({
      profileIds,
      store: params.store,
      preferred,
    });
    for (const profileId of profileIds) {
      if (profileId === keep) {
        continue;
      }
      if (params.store.profiles[profileId]) {
        delete params.store.profiles[profileId];
        removedProfileIds.push(profileId);
        changed = true;
      }
      if (params.store.usageStats?.[profileId]) {
        delete params.store.usageStats[profileId];
      }
    }
  }

  for (const profileId of resetTargetIds) {
    if (!params.store.profiles[profileId]) {
      continue;
    }
    if (resetProfileFailureState(params.store, profileId)) {
      resetProfileIds.push(profileId);
      changed = true;
    }
  }

  if (pruneDanglingStoreReferences(params.store)) {
    changed = true;
  }

  return {
    changed,
    removedProfileIds,
    resetProfileIds,
  };
}

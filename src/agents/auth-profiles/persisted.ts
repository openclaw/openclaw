/**
 * Canonical persisted auth profile loading, runtime metadata, and store merging.
 */
import {
  findNormalizedProviderKey,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { copyAuthProfileAuthorizationInheritance } from "./authorization-lifetime.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { hasUsableOAuthCredential } from "./credential-state.js";
import { hasOidcRegistration, isSafeToCopyOAuthIdentity } from "./oauth-identity.js";
import { hasOAuthIdentity, isSafeToAdoptMainStoreOAuthIdentity } from "./oauth-shared.js";
import { serializeAuthProfileCredential } from "./persisted-credential.js";
import { coercePersistedAuthProfileStore } from "./persisted-store.js";
import { removePersonalAuthProfileReferences } from "./runtime-external-profile-references.js";
import {
  inspectAuthProfileJsonCellReadOnly,
  readPersistedAuthProfileStateRaw,
  readPersistedAuthProfileStoreRaw,
  readPersistedSharedAuthProfileStateRaw,
  readPersistedSharedAuthProfileStoreRaw,
  type AuthProfileDatabase,
} from "./sqlite.js";
import { coerceAuthProfileState, mergeAuthProfileState } from "./state.js";
import { AuthProfileStoreUnreadableError } from "./store-unreadable-error.js";
import type {
  AuthProfileCredential,
  AuthProfileSecretsStore,
  AuthProfileStore,
  RuntimeAuthProfileStore,
  OAuthCredential,
} from "./types.js";

export { coercePersistedAuthProfileStore, parseAuthProfileCredential } from "./persisted-store.js";

type LoadPersistedAuthProfileStoreOptions = {
  allowKeychainPrompt?: boolean;
  database?: AuthProfileDatabase;
};

function groupProfileIdsByProvider(profiles: AuthProfileStore["profiles"]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const [profileId, credential] of Object.entries(profiles)) {
    const providerKey = normalizeProviderId(credential.provider);
    const profileIds = grouped.get(providerKey) ?? [];
    profileIds.push(profileId);
    grouped.set(providerKey, profileIds);
  }
  return grouped;
}

// Legacy OAuth profiles may be replaced by safer main-store profiles when the
// main store has a newer compatible credential for the same provider identity.
function hasComparableOAuthIdentityConflict(
  existing: OAuthCredential,
  candidate: OAuthCredential,
): boolean {
  // Registered identities cannot use the legacy fallback for missing account fields.
  if (hasOidcRegistration(existing) || hasOidcRegistration(candidate)) {
    return !isSafeToCopyOAuthIdentity(existing, candidate);
  }
  const existingAccountId = normalizeOptionalString(existing.accountId);
  const candidateAccountId = normalizeOptionalString(candidate.accountId);
  if (
    existingAccountId !== undefined &&
    candidateAccountId !== undefined &&
    existingAccountId !== candidateAccountId
  ) {
    return true;
  }

  const existingEmail = normalizeOptionalLowercaseString(existing.email);
  const candidateEmail = normalizeOptionalLowercaseString(candidate.email);
  return (
    existingEmail !== undefined && candidateEmail !== undefined && existingEmail !== candidateEmail
  );
}

function isLegacyDefaultOAuthProfile(profileId: string, credential: OAuthCredential): boolean {
  return profileId === `${normalizeProviderId(credential.provider)}:default`;
}

function isNewerUsableOAuthCredential(
  existing: OAuthCredential,
  candidate: OAuthCredential,
): boolean {
  if (!hasUsableOAuthCredential(candidate)) {
    return false;
  }
  if (!hasUsableOAuthCredential(existing)) {
    return true;
  }
  return candidate.expires > existing.expires;
}

function findMainStoreOAuthReplacement(params: {
  base: AuthProfileStore;
  legacyProfileId: string;
  legacyCredential: OAuthCredential;
}): string | undefined {
  const providerKey = normalizeProviderId(params.legacyCredential.provider);
  const candidates = Object.entries(params.base.profiles)
    .flatMap(([profileId, credential]): Array<[string, OAuthCredential]> => {
      if (
        profileId === params.legacyProfileId ||
        credential.type !== "oauth" ||
        credential.setup?.replacement ||
        normalizeProviderId(credential.provider) !== providerKey
      ) {
        return [];
      }
      return [[profileId, credential]];
    })
    .filter(([, credential]) => isNewerUsableOAuthCredential(params.legacyCredential, credential))
    .toSorted(([leftId, leftCredential], [rightId, rightCredential]) => {
      if (rightCredential.expires !== leftCredential.expires) {
        return rightCredential.expires - leftCredential.expires;
      }
      return leftId.localeCompare(rightId);
    });

  const exactIdentityCandidates = candidates.filter(([, credential]) =>
    isSafeToAdoptMainStoreOAuthIdentity(params.legacyCredential, credential),
  );
  if (exactIdentityCandidates.length > 0) {
    if (!hasOAuthIdentity(params.legacyCredential) && exactIdentityCandidates.length > 1) {
      return undefined;
    }
    return exactIdentityCandidates[0]?.[0];
  }

  if (hasUsableOAuthCredential(params.legacyCredential)) {
    return undefined;
  }
  const fallbackCandidates = candidates.filter(
    ([, credential]) => !hasComparableOAuthIdentityConflict(params.legacyCredential, credential),
  );
  if (fallbackCandidates.length !== 1) {
    return undefined;
  }
  return fallbackCandidates[0]?.[0];
}

function replaceMergedProfileReferences(params: {
  store: AuthProfileStore;
  base: AuthProfileStore;
  replacements: Map<string, string>;
}): AuthProfileStore {
  const { store, base, replacements } = params;
  if (replacements.size === 0) {
    return store;
  }

  const profiles = { ...store.profiles };
  for (const [legacyProfileId, replacementProfileId] of replacements) {
    const baseCredential = base.profiles[legacyProfileId];
    if (baseCredential) {
      profiles[legacyProfileId] = baseCredential;
    } else {
      delete profiles[legacyProfileId];
    }
    const replacementBaseCredential = base.profiles[replacementProfileId];
    const replacementCredential = profiles[replacementProfileId];
    if (
      replacementBaseCredential &&
      (!replacementCredential ||
        (replacementCredential.type === "oauth" &&
          replacementBaseCredential.type === "oauth" &&
          isNewerUsableOAuthCredential(replacementCredential, replacementBaseCredential)))
    ) {
      profiles[replacementProfileId] = replacementBaseCredential;
    }
  }

  const order = store.order
    ? Object.fromEntries(
        Object.entries(store.order).map(([provider, profileIds]) => [
          provider,
          uniqueStrings(profileIds.map((profileId) => replacements.get(profileId) ?? profileId)),
        ]),
      )
    : undefined;

  const lastGood = store.lastGood
    ? Object.fromEntries(
        Object.entries(store.lastGood).map(([provider, profileId]) => [
          provider,
          replacements.get(profileId) ?? profileId,
        ]),
      )
    : undefined;

  const usageStats = store.usageStats ? { ...store.usageStats } : undefined;
  if (usageStats) {
    for (const legacyProfileId of replacements.keys()) {
      const baseStats = base.usageStats?.[legacyProfileId];
      if (baseStats) {
        usageStats[legacyProfileId] = baseStats;
      } else {
        delete usageStats[legacyProfileId];
      }
    }
  }

  const next = {
    ...store,
    profiles,
    order: order && Object.keys(order).length > 0 ? order : undefined,
    lastGood: lastGood && Object.keys(lastGood).length > 0 ? lastGood : undefined,
    usageStats: usageStats && Object.keys(usageStats).length > 0 ? usageStats : undefined,
  };
  return next;
}

/** Merges two auth profile stores, preserving valid runtime external profile metadata. */
export function mergeAuthProfileStores(
  base: RuntimeAuthProfileStore,
  override: RuntimeAuthProfileStore,
  options?: { preserveBaseRuntimeExternalProfiles?: boolean },
): RuntimeAuthProfileStore {
  if (
    Object.keys(override.profiles).length === 0 &&
    !override.order &&
    !override.lastGood &&
    !override.usageStats &&
    override.runtimePersistedProfileIds === undefined &&
    override.runtimeLocalProfileIds === undefined &&
    override.runtimeHasLocalOAuthProfiles === undefined &&
    override.runtimeLocalOrderProviderIds === undefined &&
    override.runtimeInheritsMainState === undefined &&
    override.runtimeExternalProfileIds === undefined &&
    override.runtimeExternalProfileIdsAuthoritative !== true
  ) {
    return base;
  }
  const overrideProfileIds = new Set(Object.keys(override.profiles));
  const overrideRuntimeExternalProfileIds = new Set(override.runtimeExternalProfileIds ?? []);
  const removedRuntimeExternalProfileIds = new Set(
    override.runtimeExternalProfileIdsAuthoritative === true &&
      options?.preserveBaseRuntimeExternalProfiles !== true
      ? (base.runtimeExternalProfileIds ?? []).filter(
          (profileId) =>
            !overrideRuntimeExternalProfileIds.has(profileId) && !overrideProfileIds.has(profileId),
        )
      : [],
  );
  const profiles = Object.fromEntries([
    ...Object.entries(override.profiles),
    ...Object.entries(base.profiles).filter(([profileId]) => !overrideProfileIds.has(profileId)),
  ]);
  // Authoritative runtime snapshots may remove stale external profiles that are
  // no longer observed, unless the caller is intentionally preserving base ones.
  for (const profileId of removedRuntimeExternalProfileIds) {
    delete profiles[profileId];
  }
  const mergedState = mergeAuthProfileState(base, override);
  const baseOrder = base.order;
  const overrideOrder = override.order;
  const mergedOrder = mergedState.order;
  if (mergedOrder) {
    for (const [providerKey, localProfileIds] of groupProfileIdsByProvider(override.profiles)) {
      const baseOrderKey = findNormalizedProviderKey(baseOrder, providerKey);
      const overrideOrderKey = findNormalizedProviderKey(overrideOrder, providerKey);
      const mergedOrderKey = overrideOrderKey ?? baseOrderKey;
      if (!mergedOrderKey) {
        continue;
      }
      for (const provider of Object.keys(mergedOrder)) {
        if (provider !== mergedOrderKey && normalizeProviderId(provider) === providerKey) {
          delete mergedOrder[provider];
        }
      }
      if (overrideOrderKey) {
        mergedOrder[mergedOrderKey] = uniqueStrings(overrideOrder?.[overrideOrderKey] ?? []);
        continue;
      }
      const baseOrderIds = baseOrderKey ? (baseOrder?.[baseOrderKey] ?? []) : [];
      mergedOrder[mergedOrderKey] = uniqueStrings([
        ...localProfileIds,
        ...baseOrderIds,
        ...(mergedOrder[mergedOrderKey] ?? []),
      ]);
    }
  }
  const order = mergedOrder
    ? Object.fromEntries(
        Object.entries(mergedOrder)
          .map(
            ([provider, profileIds]) =>
              [
                provider,
                profileIds.filter(
                  (profileId) =>
                    profiles[profileId] || !removedRuntimeExternalProfileIds.has(profileId),
                ),
              ] as const,
          )
          .filter(([, profileIds]) => profileIds.length > 0),
      )
    : undefined;
  const lastGood = mergedState.lastGood
    ? Object.fromEntries(
        Object.entries(mergedState.lastGood).filter(([, profileId]) => profiles[profileId]),
      )
    : undefined;
  const usageStats = mergedState.usageStats
    ? Object.fromEntries(
        Object.entries(mergedState.usageStats).filter(
          ([profileId]) => profiles[profileId] || profileId.startsWith("inline-api-key:"),
        ),
      )
    : undefined;
  const merged = {
    version: Math.max(base.version, override.version ?? base.version),
    profiles,
    order,
    lastGood,
    usageStats,
  };
  const mergeRuntimeProfileIds = (baseIds: string[] = [], overrideIds: string[] = []) =>
    [...baseIds.filter((profileId) => !overrideProfileIds.has(profileId)), ...overrideIds]
      .filter((profileId) => merged.profiles[profileId])
      .toSorted();
  const runtimePersistedProfileIds = mergeRuntimeProfileIds(
    base.runtimePersistedProfileIds,
    override.runtimePersistedProfileIds,
  );
  const runtimeLocalProfileIds = override.runtimeLocalProfileIds
    ?.filter((profileId) => merged.profiles[profileId])
    .toSorted();
  const runtimeExternalProfileIds = mergeRuntimeProfileIds(
    override.runtimeExternalProfileIdsAuthoritative === true &&
      options?.preserveBaseRuntimeExternalProfiles !== true
      ? []
      : base.runtimeExternalProfileIds,
    override.runtimeExternalProfileIds,
  );
  const runtimeExternalProfileIdsAuthoritative =
    base.runtimeExternalProfileIdsAuthoritative === true ||
    override.runtimeExternalProfileIdsAuthoritative === true;
  const runtimeExternalProfileMetadata =
    runtimeExternalProfileIds.length > 0 || runtimeExternalProfileIdsAuthoritative
      ? {
          runtimeExternalProfileIds: [...new Set(runtimeExternalProfileIds)],
          ...(runtimeExternalProfileIdsAuthoritative
            ? { runtimeExternalProfileIdsAuthoritative: true }
            : {}),
        }
      : {};
  const runtimeMerged = {
    ...merged,
    ...(runtimePersistedProfileIds.length > 0
      ? { runtimePersistedProfileIds: [...new Set(runtimePersistedProfileIds)] }
      : {}),
    ...(runtimeLocalProfileIds ? { runtimeLocalProfileIds } : {}),
    ...(override.runtimeHasLocalOAuthProfiles !== undefined
      ? { runtimeHasLocalOAuthProfiles: override.runtimeHasLocalOAuthProfiles }
      : {}),
    ...(override.runtimeLocalOrderProviderIds !== undefined
      ? { runtimeLocalOrderProviderIds: [...override.runtimeLocalOrderProviderIds] }
      : {}),
    ...(override.runtimeInheritsMainState !== undefined
      ? { runtimeInheritsMainState: override.runtimeInheritsMainState }
      : {}),
    ...runtimeExternalProfileMetadata,
  };
  const replacements = new Map<string, string>();
  for (const [profileId, credential] of Object.entries(override.profiles)) {
    if (credential.type !== "oauth") {
      continue;
    }
    const replacementProfileId = isLegacyDefaultOAuthProfile(profileId, credential)
      ? findMainStoreOAuthReplacement({
          base,
          legacyProfileId: profileId,
          legacyCredential: credential,
        })
      : undefined;
    if (replacementProfileId) {
      replacements.set(profileId, replacementProfileId);
    }
  }
  const result = replaceMergedProfileReferences({
    store: runtimeMerged,
    base,
    replacements,
  }) as RuntimeAuthProfileStore;
  if (base.runtimeCredentialSources || override.runtimeCredentialSources) {
    // Reconciliation can select main's OAuth row instead of the local override.
    result.runtimeCredentialSources = Object.fromEntries(
      Object.entries(result.profiles).flatMap(([profileId, credential]) => {
        const source =
          credential === override.profiles[profileId]
            ? override.runtimeCredentialSources?.[profileId]
            : credential === base.profiles[profileId]
              ? base.runtimeCredentialSources?.[profileId]
              : undefined;
        return source ? [[profileId, source]] : [];
      }),
    );
  }
  return result;
}

/** Builds the persisted secrets store, stripping resolved literals when refs exist. */
export function buildPersistedAuthProfileSecretsStore(
  store: AuthProfileStore,
  shouldPersistProfile?: (params: {
    profileId: string;
    credential: AuthProfileCredential;
  }) => boolean,
): AuthProfileSecretsStore {
  const profiles = { ...store.profiles };
  for (const [profileId, credential] of Object.entries(profiles)) {
    if (
      isUserModelAuthProfileId(profileId) ||
      (shouldPersistProfile && !shouldPersistProfile({ profileId, credential }))
    ) {
      delete profiles[profileId];
    } else {
      profiles[profileId] = serializeAuthProfileCredential(credential);
    }
  }
  copyAuthProfileAuthorizationInheritance(store.profiles, profiles);

  return {
    version: AUTH_STORE_VERSION,
    profiles,
  };
}

export function mergePersistedAuthProfileState(
  raw: unknown,
  readState: () => unknown,
): AuthProfileStore | null {
  const store = coercePersistedAuthProfileStore(raw);
  if (!store) {
    return null;
  }
  return removePersonalAuthProfileReferences({
    ...store,
    ...mergeAuthProfileState(store, coerceAuthProfileState(readState())),
  });
}

/** Loads the persisted auth profile store and merges runtime state. */
export function loadPersistedAuthProfileStore(
  agentDir?: string,
  options?: LoadPersistedAuthProfileStoreOptions,
): AuthProfileStore | null {
  return mergePersistedAuthProfileState(
    readPersistedAuthProfileStoreRaw(agentDir, options?.database),
    () => readPersistedAuthProfileStateRaw(agentDir, options?.database),
  );
}

/** Read an already selected owner without rediscovering an environment or opening a writer. */
export function loadPersistedAuthProfileStoreAtDatabasePath(
  databasePath: string,
  kind: "agent" | "shared-state",
): AuthProfileStore | null {
  const target = { path: databasePath, kind };
  const credentials = inspectAuthProfileJsonCellReadOnly(target, "store");
  if (credentials.status === "missing") {
    return null;
  }
  if (credentials.status === "unreadable") {
    throw new AuthProfileStoreUnreadableError(databasePath);
  }
  const state = inspectAuthProfileJsonCellReadOnly(target, "state");
  const store = mergePersistedAuthProfileState(credentials.raw, () =>
    state.status === "readable" ? state.raw : null,
  );
  if (!store) {
    throw new AuthProfileStoreUnreadableError(databasePath);
  }
  return store;
}

/** Load the shared auth store from an explicit state root. */
export function loadPersistedSharedAuthProfileStore(
  env: NodeJS.ProcessEnv,
): AuthProfileStore | null {
  return mergePersistedAuthProfileState(readPersistedSharedAuthProfileStoreRaw(env), () =>
    readPersistedSharedAuthProfileStateRaw(env),
  );
}

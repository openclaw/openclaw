/**
 * Canonical persisted auth profile loading, runtime metadata, and store merging.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  readNonBlankString,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { coerceSecretRef, isLegacySecretRefWithoutProvider } from "../../config/types.secrets.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { AUTH_STORE_VERSION, authProfilesLog } from "./constants.js";
import { hasUsableOAuthCredential } from "./credential-state.js";
import { hasOidcRegistration, isSafeToCopyOAuthIdentity } from "./oauth-identity.js";
import { hasOAuthIdentity, isSafeToAdoptMainStoreOAuthIdentity } from "./oauth-shared.js";
import { normalizeRawCredentialEntry } from "./persisted-credential.js";
import {
  getRuntimeExternalCliProfileIds,
  removePersonalAuthProfileReferences,
  setRuntimeExternalCliProfileIds,
} from "./runtime-external-profile-references.js";
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

type LoadPersistedAuthProfileStoreOptions = {
  allowKeychainPrompt?: boolean;
  database?: AuthProfileDatabase;
};

type CredentialRejectReason = "non_object" | "invalid_type" | "missing_provider";
type RejectedCredentialEntry = { key: string; reason: CredentialRejectReason };

const AUTH_PROFILE_TYPES = new Set<AuthProfileCredential["type"]>(["api_key", "oauth", "token"]);
const INLINE_API_KEY_USAGE_ID_PREFIX = "inline-api-key:";

function isRetainedUsageStatsId(
  profileId: string,
  profiles: AuthProfileStore["profiles"],
): boolean {
  return Boolean(profiles[profileId]) || profileId.startsWith(INLINE_API_KEY_USAGE_ID_PREFIX);
}

function parseCredentialEntry(
  raw: unknown,
  fallbackProvider?: string,
): { ok: true; credential: AuthProfileCredential } | { ok: false; reason: CredentialRejectReason } {
  if (!isRecord(raw)) {
    return { ok: false, reason: "non_object" };
  }
  const typed = normalizeRawCredentialEntry(raw);
  if (!typed) {
    return { ok: false, reason: "invalid_type" };
  }
  const provider = typed.provider || fallbackProvider;
  const normalizedProvider = typeof provider === "string" ? normalizeProviderId(provider) : "";
  if (!normalizedProvider) {
    return { ok: false, reason: "missing_provider" };
  }
  return {
    ok: true,
    credential: {
      ...typed,
      provider: normalizedProvider,
    } as AuthProfileCredential,
  };
}

/** Parses canonical credential fields without importing retired encodings. */
export function parseAuthProfileCredential(
  raw: unknown,
  fallbackProvider?: string,
): AuthProfileCredential | null {
  const parsed = parseCredentialEntry(raw, fallbackProvider);
  return parsed.ok ? parsed.credential : null;
}

function warnRejectedCredentialEntries(source: string, rejected: RejectedCredentialEntry[]): void {
  if (rejected.length === 0) {
    return;
  }
  const reasons = rejected.reduce<Partial<Record<CredentialRejectReason, number>>>(
    (acc, current) => {
      acc[current.reason] = (acc[current.reason] ?? 0) + 1;
      return acc;
    },
    {},
  );
  authProfilesLog.warn("ignored invalid auth profile entries during store load", {
    source,
    dropped: rejected.length,
    reasons,
    ...(reasons.invalid_type ? { validTypes: [...AUTH_PROFILE_TYPES] } : {}),
    keys: rejected.slice(0, 10).map((entry) => entry.key),
  });
}

/** Coerces a persisted auth profile store payload into the current store shape. */
export function coercePersistedAuthProfileStore(raw: unknown): AuthProfileStore | null {
  if (!isRecord(raw)) {
    return null;
  }
  const record = raw;
  if (!isRecord(record.profiles)) {
    return null;
  }
  const profiles = record.profiles;
  const normalized: Record<string, AuthProfileCredential> = {};
  const rejected: RejectedCredentialEntry[] = [];
  for (const [key, value] of Object.entries(profiles)) {
    const declaredType = isRecord(value)
      ? Object.hasOwn(value, "type")
        ? value.type
        : value.mode
      : undefined;
    const supportedType =
      declaredType === "apiKey" ||
      declaredType === "api_key" ||
      declaredType === "token" ||
      declaredType === "oauth";
    if (
      supportedType &&
      isRecord(value) &&
      typeof value.provider === "string" &&
      normalizeProviderId(value.provider) &&
      (!Object.hasOwn(value, "type") ||
        value.type === "apiKey" ||
        (declaredType === "api_key" && isLegacySecretRefWithoutProvider(value.keyRef)) ||
        (declaredType === "token" && isLegacySecretRefWithoutProvider(value.tokenRef)) ||
        (declaredType === "api_key" &&
          !coerceSecretRef(value.keyRef) &&
          ((isRecord(value.key) && coerceSecretRef(value.key) !== null) ||
            (!readNonBlankString(value.key) &&
              !coerceSecretRef(value.key) &&
              (readNonBlankString(value.apiKey) !== undefined ||
                coerceSecretRef(value.apiKey) !== null ||
                readNonBlankString(value.api_key) !== undefined ||
                coerceSecretRef(value.api_key) !== null)))) ||
        (declaredType === "token" &&
          !coerceSecretRef(value.tokenRef) &&
          isRecord(value.token) &&
          coerceSecretRef(value.token) !== null))
    ) {
      throw new Error(
        "Auth profile credential fields require migration; run openclaw doctor --fix.",
      );
    }
    const parsed = parseCredentialEntry(value);
    if (!parsed.ok) {
      rejected.push({ key, reason: parsed.reason });
      continue;
    }
    normalized[key] = parsed.credential;
  }
  warnRejectedCredentialEntries("auth-profiles.json", rejected);
  const version = Number(record.version ?? AUTH_STORE_VERSION);
  return {
    version: Number.isFinite(version) && version > 0 ? version : AUTH_STORE_VERSION,
    profiles: normalized,
    ...coerceAuthProfileState(record),
  };
}

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

function findOrderEntryKey(
  order: AuthProfileStore["order"] | undefined,
  providerKey: string,
): string | undefined {
  return Object.keys(order ?? {}).find((key) => normalizeProviderId(key) === providerKey);
}

function mergeProfileRecordsWithOverridePrecedence(
  base: AuthProfileStore["profiles"],
  override: AuthProfileStore["profiles"],
): AuthProfileStore["profiles"] {
  const overrideProfileIds = new Set(Object.keys(override));
  return Object.fromEntries([
    ...Object.entries(override),
    ...Object.entries(base).filter(([profileId]) => !overrideProfileIds.has(profileId)),
  ]);
}

function mergeProfileOrderWithOverridePrecedence(params: {
  baseOrder: AuthProfileStore["order"] | undefined;
  overrideOrder: AuthProfileStore["order"] | undefined;
  overrideProfiles: AuthProfileStore["profiles"];
  mergedOrder: AuthProfileStore["order"] | undefined;
}): AuthProfileStore["order"] | undefined {
  const { mergedOrder } = params;
  if (!mergedOrder) {
    return undefined;
  }

  for (const [providerKey, overrideProfileIds] of groupProfileIdsByProvider(
    params.overrideProfiles,
  )) {
    const baseOrderKey = findOrderEntryKey(params.baseOrder, providerKey);
    const overrideOrderKey = findOrderEntryKey(params.overrideOrder, providerKey);
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
      mergedOrder[mergedOrderKey] = uniqueStrings(params.overrideOrder?.[overrideOrderKey] ?? []);
      continue;
    }
    const baseOrderIds = baseOrderKey ? (params.baseOrder?.[baseOrderKey] ?? []) : [];
    mergedOrder[mergedOrderKey] = uniqueStrings([
      ...overrideProfileIds,
      ...baseOrderIds,
      ...(mergedOrder[mergedOrderKey] ?? []),
    ]);
  }

  return mergedOrder;
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
      const leftExpires = Number.isFinite(leftCredential.expires) ? leftCredential.expires : 0;
      const rightExpires = Number.isFinite(rightCredential.expires) ? rightCredential.expires : 0;
      if (rightExpires !== leftExpires) {
        return rightExpires - leftExpires;
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
    ...(order && Object.keys(order).length > 0 ? { order } : { order: undefined }),
    ...(lastGood && Object.keys(lastGood).length > 0 ? { lastGood } : { lastGood: undefined }),
    ...(usageStats && Object.keys(usageStats).length > 0
      ? { usageStats }
      : { usageStats: undefined }),
  };
  setRuntimeExternalCliProfileIds(
    next,
    getRuntimeExternalCliProfileIds(store).map(
      (profileId) => replacements.get(profileId) ?? profileId,
    ),
  );
  return next;
}

function reconcileMainStoreOAuthProfileDrift(params: {
  base: AuthProfileStore;
  override: AuthProfileStore;
  merged: AuthProfileStore;
}): AuthProfileStore {
  const replacements = new Map<string, string>();
  for (const [profileId, credential] of Object.entries(params.override.profiles)) {
    if (credential.type !== "oauth") {
      continue;
    }
    const replacementProfileId = isLegacyDefaultOAuthProfile(profileId, credential)
      ? findMainStoreOAuthReplacement({
          base: params.base,
          legacyProfileId: profileId,
          legacyCredential: credential,
        })
      : undefined;
    if (replacementProfileId) {
      replacements.set(profileId, replacementProfileId);
    }
  }
  return replaceMergedProfileReferences({
    store: params.merged,
    base: params.base,
    replacements,
  });
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
    override.runtimeLocalOrderProviderIds === undefined &&
    override.runtimeInheritsMainState === undefined &&
    override.runtimeExternalProfileIds === undefined &&
    override.runtimeExternalProfileIdsAuthoritative !== true &&
    getRuntimeExternalCliProfileIds(override).length === 0
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
  const profiles = mergeProfileRecordsWithOverridePrecedence(base.profiles, override.profiles);
  // Authoritative runtime snapshots may remove stale external profiles that are
  // no longer observed, unless the caller is intentionally preserving base ones.
  for (const profileId of removedRuntimeExternalProfileIds) {
    delete profiles[profileId];
  }
  const mergedState = mergeAuthProfileState(base, override);
  const mergedOrder = mergeProfileOrderWithOverridePrecedence({
    baseOrder: base.order,
    overrideOrder: override.order,
    overrideProfiles: override.profiles,
    mergedOrder: mergedState.order,
  });
  const order = mergedOrder
    ? Object.fromEntries(
        Object.entries(mergedOrder)
          .map(([provider, profileIds]) => [
            provider,
            profileIds.filter(
              (profileId) =>
                profiles[profileId] || !removedRuntimeExternalProfileIds.has(profileId),
            ),
          ])
          .filter(([, profileIds]) => Array.isArray(profileIds) && profileIds.length > 0),
      )
    : undefined;
  const lastGood = mergedState.lastGood
    ? Object.fromEntries(
        Object.entries(mergedState.lastGood).filter(([, profileId]) => profiles[profileId]),
      )
    : undefined;
  const usageStats = mergedState.usageStats
    ? Object.fromEntries(
        Object.entries(mergedState.usageStats).filter(([profileId]) =>
          isRetainedUsageStatsId(profileId, profiles),
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
  const runtimePersistedProfileIds = [
    ...(base.runtimePersistedProfileIds ?? []).filter(
      (profileId) => !overrideProfileIds.has(profileId),
    ),
    ...(override.runtimePersistedProfileIds ?? []),
  ]
    .filter((profileId) => merged.profiles[profileId])
    .toSorted();
  const runtimeLocalProfileIds = override.runtimeLocalProfileIds
    ?.filter((profileId) => merged.profiles[profileId])
    .toSorted();
  const baseRuntimeExternalProfileIds =
    override.runtimeExternalProfileIdsAuthoritative === true &&
    options?.preserveBaseRuntimeExternalProfiles !== true
      ? []
      : (base.runtimeExternalProfileIds ?? []).filter(
          (profileId) => !overrideProfileIds.has(profileId),
        );
  const runtimeExternalProfileIds = [
    ...baseRuntimeExternalProfileIds,
    ...(override.runtimeExternalProfileIds ?? []),
  ]
    .filter((profileId) => merged.profiles[profileId])
    .toSorted();
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
  const runtimeExternalCliProfileIds = [
    ...getRuntimeExternalCliProfileIds(base).filter(
      (profileId) =>
        !overrideProfileIds.has(profileId) && !removedRuntimeExternalProfileIds.has(profileId),
    ),
    ...getRuntimeExternalCliProfileIds(override),
  ];
  const result = reconcileMainStoreOAuthProfileDrift({
    base,
    override,
    merged: {
      ...merged,
      ...(runtimePersistedProfileIds.length > 0
        ? { runtimePersistedProfileIds: [...new Set(runtimePersistedProfileIds)] }
        : {}),
      ...(runtimeLocalProfileIds ? { runtimeLocalProfileIds } : {}),
      ...(override.runtimeLocalOrderProviderIds !== undefined
        ? { runtimeLocalOrderProviderIds: [...override.runtimeLocalOrderProviderIds] }
        : {}),
      ...(override.runtimeInheritsMainState !== undefined
        ? { runtimeInheritsMainState: override.runtimeInheritsMainState }
        : {}),
      ...runtimeExternalProfileMetadata,
    },
  }) as RuntimeAuthProfileStore;
  setRuntimeExternalCliProfileIds(result, runtimeExternalCliProfileIds);
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
    } else if (credential.type === "api_key" && credential.keyRef && credential.key !== undefined) {
      const { key: _key, ...sanitized } = credential;
      profiles[profileId] = sanitized;
    } else if (
      credential.type === "token" &&
      credential.tokenRef &&
      credential.token !== undefined
    ) {
      const { token: _token, ...sanitized } = credential;
      profiles[profileId] = sanitized;
    }
  }

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

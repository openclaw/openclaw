import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
/** Internal auth-profile sidecar for catalog request authentication. */
import type { AuthProfileStore, AuthProfileCredential } from "../auth-profiles/types.js";
import {
  resolveProviderIdForAuth,
  type ProviderAuthAliasLookupParams,
} from "../provider-auth-aliases.js";
import { resolveConfigValue } from "./resolve-config-value.js";

type ProfileData = Record<string, AuthProfileCredential>;
type ProfileSelection = {
  profile: AuthProfileCredential;
  /** Revalidate the selected physical owner and credential after request preparation yields. */
  assertCurrent?: () => void;
};
type LiveProfileReader = (
  provider: string,
  profileId: string,
  baseUrl?: string,
) => ProfileSelection | undefined;

const profileDataByStorage = new WeakMap<object, ProfileData>();
const runtimeOverrideByStorage = new WeakMap<object, (provider: string) => string | undefined>();
const credentialFreeStorage = new WeakSet<object>();
const liveProfileReaders = new WeakMap<object, LiveProfileReader>();
const liveProfileIdentityReaders = new WeakMap<object, (profileId: string) => boolean>();

export function registerAuthStorageRuntimeOverride(
  storage: object,
  resolve: (provider: string) => string | undefined,
): void {
  runtimeOverrideByStorage.set(storage, resolve);
}

export function attachAuthStorageProfiles<T extends object>(
  storage: T,
  store: AuthProfileStore,
): T {
  profileDataByStorage.set(storage, structuredClone(store.profiles));
  return storage;
}

/** Persistent owners resolve exact profiles through their current canonical read scope. */
export function attachLiveAuthStorageProfiles<T extends object>(
  storage: T,
  read: LiveProfileReader,
  hasProfileId: (profileId: string) => boolean,
): T {
  liveProfileReaders.set(storage, read);
  liveProfileIdentityReaders.set(storage, hasProfileId);
  return storage;
}

export function copyAuthStorageProfiles(source: object, target: object): void {
  profileDataByStorage.set(target, structuredClone(profileDataByStorage.get(source) ?? {}));
}

/** Identity is independent of expiry, provider compatibility, and source readiness. */
export function hasAuthStorageProfileId(storage: object, profileId: string): boolean {
  try {
    return (
      liveProfileIdentityReaders.get(storage)?.(profileId) ??
      Object.hasOwn(profileDataByStorage.get(storage) ?? {}, profileId)
    );
  } catch {
    // An unreadable canonical owner cannot authorize reinterpretation as an env name.
    return true;
  }
}

function resolveProfile(
  storage: object,
  provider: string,
  profileId: string,
  baseUrl?: string,
  aliasLookup?: ProviderAuthAliasLookupParams,
): ProfileSelection | undefined {
  if (credentialFreeStorage.has(storage)) {
    return undefined;
  }
  const read = liveProfileReaders.get(storage);
  const snapshot = profileDataByStorage.get(storage)?.[profileId];
  const selection = read
    ? read(provider, profileId, baseUrl)
    : snapshot
      ? { profile: snapshot }
      : undefined;
  const profile = selection?.profile;
  return profile &&
    (normalizeProviderId(profile.provider) === normalizeProviderId(provider) ||
      resolveProviderIdForAuth(profile.provider, { ...aliasLookup, storedCredential: true }) ===
        resolveProviderIdForAuth(provider, aliasLookup))
    ? selection
    : undefined;
}

export function hasAuthStorageProfile(
  storage: object,
  provider: string,
  profileId: string,
  options?: {
    includeRuntimeOverride?: boolean;
    baseUrl?: string;
    aliasLookup?: ProviderAuthAliasLookupParams;
  },
): boolean {
  if (
    options?.includeRuntimeOverride !== false &&
    runtimeOverrideByStorage.get(storage)?.(provider)
  ) {
    return true;
  }
  try {
    const profile = resolveProfile(
      storage,
      provider,
      profileId,
      options?.baseUrl,
      options?.aliasLookup,
    )?.profile;
    return Boolean(
      (profile?.type === "api_key" && profile.key) ||
      (profile?.type === "token" &&
        profile.token &&
        (profile.expires === undefined || Date.now() < profile.expires)),
    );
  } catch {
    // Availability is advisory; request-time resolution propagates canonical refusal.
    return false;
  }
}

export function resolveAuthStorageProfileApiKey(
  storage: object,
  provider: string,
  profileId: string,
  baseUrl?: string,
  aliasLookup?: ProviderAuthAliasLookupParams,
): { apiKey: string | undefined; assertCurrent?: () => void } {
  const runtimeOverride = runtimeOverrideByStorage.get(storage)?.(provider);
  if (runtimeOverride) {
    return { apiKey: runtimeOverride };
  }
  const selection = resolveProfile(storage, provider, profileId, baseUrl, aliasLookup);
  const profile = selection?.profile;
  const apiKey =
    profile?.type === "api_key" && profile.key
      ? resolveConfigValue(profile.key)
      : profile?.type === "token" &&
          profile.token &&
          (profile.expires === undefined || Date.now() < profile.expires)
        ? resolveConfigValue(profile.token)
        : undefined;
  return { apiKey, assertCurrent: selection?.assertCurrent };
}

export function markAuthStorageCredentialFree<T extends object>(storage: T): T {
  credentialFreeStorage.add(storage);
  return storage;
}

export function isAuthStorageCredentialFree(storage: object): boolean {
  return credentialFreeStorage.has(storage);
}

import { cloneAuthProfileStore } from "./clone.js";
import { hasUsableOAuthCredential } from "./credential-state.js";
import {
  hasOAuthIdentity,
  isSafeToCopyOAuthIdentity,
  type OAuthIdentity,
} from "./oauth-identity.js";
import type { AuthProfileStore, OAuthCredential, RuntimeAuthProfileStore } from "./types.js";

export { hasOAuthIdentity } from "./oauth-identity.js";

export type RuntimeExternalOAuthProfile = {
  profileId: string;
  credential: OAuthCredential;
  persistence?: "runtime-only" | "persisted";
};

export function areOAuthCredentialsEquivalent(
  a: OAuthCredential | undefined,
  b: OAuthCredential,
): boolean {
  if (!a || a.type !== "oauth") {
    return false;
  }
  return (
    a.provider === b.provider &&
    a.access === b.access &&
    a.refresh === b.refresh &&
    a.expires === b.expires &&
    a.email === b.email &&
    a.enterpriseUrl === b.enterpriseUrl &&
    a.projectId === b.projectId &&
    a.accountId === b.accountId &&
    a.idToken === b.idToken
  );
}

export function hasMatchingOAuthIdentity(
  existing: OAuthIdentity,
  incoming: OAuthIdentity,
): boolean {
  return hasOAuthIdentity(existing) && isSafeToCopyOAuthIdentity(existing, incoming);
}

export function isSafeOAuthOwnerRefreshResult(
  claimed: OAuthCredential,
  refreshed: OAuthCredential,
): boolean {
  return claimed.provider === refreshed.provider && isSafeToCopyOAuthIdentity(claimed, refreshed);
}

export function isSafeOAuthPostClaimSettlement(
  claimedGeneration: OAuthCredential,
  candidate: OAuthCredential | undefined,
): candidate is OAuthCredential {
  return (
    candidate?.type === "oauth" &&
    candidate.provider === claimedGeneration.provider &&
    hasUsableOAuthCredential(candidate) &&
    hasMatchingOAuthIdentity(claimedGeneration, candidate)
  );
}

export function isSafeToAdoptBootstrapOAuthIdentity(
  existing: OAuthCredential | undefined,
  incoming: OAuthCredential,
): boolean {
  return (
    !existing || existing.type !== "oauth" || isSafeOAuthOwnerRefreshResult(existing, incoming)
  );
}

export function isSafeToAdoptMainStoreOAuthIdentity(
  existing: OAuthCredential | undefined,
  incoming: OAuthCredential,
): boolean {
  return existing?.type === "oauth" && isSafeOAuthOwnerRefreshResult(existing, incoming);
}

/** Overlays runtime external OAuth profiles on a cloned store. */
export function overlayRuntimeExternalOAuthProfiles(
  store: AuthProfileStore,
  profiles: Iterable<RuntimeExternalOAuthProfile>,
  options?: { runtimeExternalProfileIdsAuthoritative?: boolean },
): AuthProfileStore {
  const externalProfiles = Array.from(profiles);
  const next: RuntimeAuthProfileStore = cloneAuthProfileStore(store);
  const overlaidProfileIds = new Set(externalProfiles.map((profile) => profile.profileId));
  for (const profile of externalProfiles) {
    next.profiles[profile.profileId] = profile.credential;
    delete next.runtimeCredentialSources?.[profile.profileId];
  }
  next.runtimePersistedProfileIds = store.runtimePersistedProfileIds
    ?.filter((profileId) => next.profiles[profileId] && !overlaidProfileIds.has(profileId))
    .toSorted();
  if (next.runtimePersistedProfileIds?.length === 0) {
    next.runtimePersistedProfileIds = undefined;
  }
  const runtimeOnlyProfileIds = new Set(
    externalProfiles
      .filter((profile) => profile.persistence !== "persisted")
      .map((profile) => profile.profileId),
  );
  // Preserve previous runtime-only profile ids that still exist so repeated
  // overlays do not accidentally persist or drop external profile metadata.
  for (const profileId of store.runtimeExternalProfileIds ?? []) {
    if (next.profiles[profileId]) {
      runtimeOnlyProfileIds.add(profileId);
    }
  }
  next.runtimeExternalProfileIds =
    runtimeOnlyProfileIds.size > 0 || options?.runtimeExternalProfileIdsAuthoritative === true
      ? [...runtimeOnlyProfileIds].toSorted()
      : undefined;
  next.runtimeExternalProfileIdsAuthoritative =
    options?.runtimeExternalProfileIdsAuthoritative === true ? true : undefined;
  return next;
}

export function shouldPersistRuntimeExternalOAuthProfile(params: {
  profileId: string;
  credential: OAuthCredential;
  profiles: Iterable<RuntimeExternalOAuthProfile>;
}): boolean {
  for (const profile of params.profiles) {
    if (profile.profileId !== params.profileId) {
      continue;
    }
    if (profile.persistence === "persisted") {
      return true;
    }
    return !areOAuthCredentialsEquivalent(profile.credential, params.credential);
  }
  return true;
}

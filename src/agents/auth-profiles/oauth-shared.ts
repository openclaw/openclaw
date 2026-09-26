/**
 * Shared OAuth credential identity policy.
 * Used by manager, external CLI overlays, and persistence paths to decide when
 * incoming runtime credentials may bootstrap or settle stored profiles.
 */
import { cloneAuthProfileStore } from "./clone.js";
import { hasUsableOAuthCredential } from "./credential-state.js";
import {
  hasOAuthIdentity,
  isSafeToCopyOAuthIdentity,
  type OAuthIdentity,
} from "./oauth-identity.js";
import type { AuthProfileStore, OAuthCredential, RuntimeAuthProfileStore } from "./types.js";

export {
  hasOAuthIdentity,
  normalizeAuthEmailToken,
  normalizeAuthIdentityToken,
} from "./oauth-identity.js";

/** OAuth profile imported from a runtime external CLI source. */
export type RuntimeExternalOAuthProfile = {
  profileId: string;
  credential: OAuthCredential;
  persistence?: "runtime-only" | "persisted";
};

/** Returns true when two OAuth credentials contain the same token/identity data. */
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

/** Returns true when both credentials describe the same registered identity. */
export function hasMatchingOAuthIdentity(
  existing: OAuthIdentity,
  incoming: OAuthIdentity,
): boolean {
  return hasOAuthIdentity(existing) && isSafeToCopyOAuthIdentity(existing, incoming);
}

/** Returns true when the current owner accepts its provider refresh result. */
export function isSafeOAuthOwnerRefreshResult(
  claimed: OAuthCredential,
  refreshed: OAuthCredential,
): boolean {
  return claimed.provider === refreshed.provider && isSafeToCopyOAuthIdentity(claimed, refreshed);
}

/** Returns true when a claimed generation may settle with a live credential. */
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

function isSafeOAuthIdentityTransition(
  existing: OAuthCredential | undefined,
  incoming: OAuthCredential,
  allowMissingCredential: boolean,
): boolean {
  if (!existing || existing.type !== "oauth") {
    return allowMissingCredential;
  }
  if (existing.provider !== incoming.provider) {
    return false;
  }
  return isSafeToCopyOAuthIdentity(existing, incoming);
}

/** Returns true when bootstrap may adopt an external OAuth identity. */
export function isSafeToAdoptBootstrapOAuthIdentity(
  existing: OAuthCredential | undefined,
  incoming: OAuthCredential,
): boolean {
  return isSafeOAuthIdentityTransition(existing, incoming, true);
}

/** Returns true when agent-local state may adopt a main-store OAuth identity. */
export function isSafeToAdoptMainStoreOAuthIdentity(
  existing: OAuthCredential | undefined,
  incoming: OAuthCredential,
): boolean {
  return isSafeOAuthIdentityTransition(existing, incoming, false);
}

/** Returns true when an external CLI credential should bootstrap stored OAuth. */
export function shouldBootstrapFromExternalCliCredential(params: {
  existing: OAuthCredential | undefined;
  imported: OAuthCredential;
  now?: number;
}): boolean {
  const now = params.now ?? Date.now();
  if (hasUsableOAuthCredential(params.existing, { now })) {
    return false;
  }
  return hasUsableOAuthCredential(params.imported, { now });
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

/** Returns true when a runtime external OAuth profile should be persisted. */
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

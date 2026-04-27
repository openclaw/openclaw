import { hasUsableOAuthCredential as hasUsableStoredOAuthCredential } from "./credential-state.js";
export function areOAuthCredentialsEquivalent(a, b) {
    if (!a || a.type !== "oauth") {
        return false;
    }
    return (a.provider === b.provider &&
        a.access === b.access &&
        a.refresh === b.refresh &&
        a.expires === b.expires &&
        a.email === b.email &&
        a.enterpriseUrl === b.enterpriseUrl &&
        a.projectId === b.projectId &&
        a.accountId === b.accountId &&
        a.idToken === b.idToken);
}
function hasNewerStoredOAuthCredential(existing, incoming) {
    return Boolean(existing &&
        existing.provider === incoming.provider &&
        Number.isFinite(existing.expires) &&
        (!Number.isFinite(incoming.expires) || existing.expires > incoming.expires));
}
export function shouldReplaceStoredOAuthCredential(existing, incoming) {
    if (!existing || existing.type !== "oauth") {
        return true;
    }
    if (areOAuthCredentialsEquivalent(existing, incoming)) {
        return false;
    }
    return !hasNewerStoredOAuthCredential(existing, incoming);
}
export function hasUsableOAuthCredential(credential, now = Date.now()) {
    return hasUsableStoredOAuthCredential(credential, { now });
}
export function normalizeAuthIdentityToken(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
export function normalizeAuthEmailToken(value) {
    return normalizeAuthIdentityToken(value)?.toLowerCase();
}
export function hasOAuthIdentity(credential) {
    return (normalizeAuthIdentityToken(credential.accountId) !== undefined ||
        normalizeAuthEmailToken(credential.email) !== undefined);
}
function hasMatchingOAuthIdentity(existing, incoming) {
    const existingAccountId = normalizeAuthIdentityToken(existing.accountId);
    const incomingAccountId = normalizeAuthIdentityToken(incoming.accountId);
    if (existingAccountId !== undefined && incomingAccountId !== undefined) {
        return existingAccountId === incomingAccountId;
    }
    const existingEmail = normalizeAuthEmailToken(existing.email);
    const incomingEmail = normalizeAuthEmailToken(incoming.email);
    if (existingEmail !== undefined && incomingEmail !== undefined) {
        return existingEmail === incomingEmail;
    }
    return false;
}
export function isSafeToOverwriteStoredOAuthIdentity(existing, incoming) {
    if (!existing || existing.type !== "oauth") {
        return true;
    }
    if (existing.provider !== incoming.provider) {
        return false;
    }
    if (areOAuthCredentialsEquivalent(existing, incoming)) {
        return true;
    }
    if (!hasOAuthIdentity(existing)) {
        return false;
    }
    return hasMatchingOAuthIdentity(existing, incoming);
}
export function isSafeToAdoptBootstrapOAuthIdentity(existing, incoming) {
    if (!existing || existing.type !== "oauth") {
        return true;
    }
    if (existing.provider !== incoming.provider) {
        return false;
    }
    if (areOAuthCredentialsEquivalent(existing, incoming)) {
        return true;
    }
    if (!hasOAuthIdentity(existing)) {
        return true;
    }
    return hasMatchingOAuthIdentity(existing, incoming);
}
export function isSafeToAdoptMainStoreOAuthIdentity(existing, incoming) {
    if (!existing || existing.type !== "oauth") {
        return false;
    }
    if (existing.provider !== incoming.provider) {
        return false;
    }
    if (areOAuthCredentialsEquivalent(existing, incoming)) {
        return true;
    }
    if (!hasOAuthIdentity(existing)) {
        return true;
    }
    return hasMatchingOAuthIdentity(existing, incoming);
}
export function shouldBootstrapFromExternalCliCredential(params) {
    const now = params.now ?? Date.now();
    if (hasUsableOAuthCredential(params.existing, now)) {
        return false;
    }
    return hasUsableOAuthCredential(params.imported, now);
}
export function overlayRuntimeExternalOAuthProfiles(store, profiles) {
    const externalProfiles = Array.from(profiles);
    if (externalProfiles.length === 0) {
        return store;
    }
    const next = structuredClone(store);
    for (const profile of externalProfiles) {
        next.profiles[profile.profileId] = profile.credential;
    }
    return next;
}
export function shouldPersistRuntimeExternalOAuthProfile(params) {
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

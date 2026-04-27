export function normalizeAuthIdentityToken(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
export function normalizeAuthEmailToken(value) {
    return normalizeAuthIdentityToken(value)?.toLowerCase();
}
/**
 * Returns true if `existing` and `incoming` provably belong to the same
 * account. Used to gate cross-agent credential mirroring.
 */
export function isSameOAuthIdentity(existing, incoming) {
    const aAcct = normalizeAuthIdentityToken(existing.accountId);
    const bAcct = normalizeAuthIdentityToken(incoming.accountId);
    const aEmail = normalizeAuthEmailToken(existing.email);
    const bEmail = normalizeAuthEmailToken(incoming.email);
    const aHasIdentity = aAcct !== undefined || aEmail !== undefined;
    const bHasIdentity = bAcct !== undefined || bEmail !== undefined;
    if (aHasIdentity !== bHasIdentity) {
        return false;
    }
    if (aHasIdentity) {
        if (aAcct !== undefined && bAcct !== undefined) {
            return aAcct === bAcct;
        }
        if (aEmail !== undefined && bEmail !== undefined) {
            return aEmail === bEmail;
        }
        return false;
    }
    return true;
}
/**
 * One-sided copy gate for both directions:
 * - mirror: sub-agent refresh -> main-agent store
 * - adopt: main-agent store -> sub-agent store
 */
export function isSafeToCopyOAuthIdentity(existing, incoming) {
    const aAcct = normalizeAuthIdentityToken(existing.accountId);
    const bAcct = normalizeAuthIdentityToken(incoming.accountId);
    const aEmail = normalizeAuthEmailToken(existing.email);
    const bEmail = normalizeAuthEmailToken(incoming.email);
    if (aAcct !== undefined && bAcct !== undefined) {
        return aAcct === bAcct;
    }
    if (aEmail !== undefined && bEmail !== undefined) {
        return aEmail === bEmail;
    }
    const aHasIdentity = aAcct !== undefined || aEmail !== undefined;
    if (aHasIdentity) {
        return false;
    }
    return true;
}
export function shouldMirrorRefreshedOAuthCredential(params) {
    const { existing, refreshed } = params;
    if (!existing) {
        return { shouldMirror: true, reason: "no-existing-credential" };
    }
    if (existing.type !== "oauth") {
        return { shouldMirror: false, reason: "non-oauth-existing-credential" };
    }
    if (existing.provider !== refreshed.provider) {
        return { shouldMirror: false, reason: "provider-mismatch" };
    }
    if (!isSafeToCopyOAuthIdentity(existing, refreshed)) {
        return { shouldMirror: false, reason: "identity-mismatch-or-regression" };
    }
    if (Number.isFinite(existing.expires) &&
        Number.isFinite(refreshed.expires) &&
        existing.expires >= refreshed.expires) {
        return { shouldMirror: false, reason: "incoming-not-fresher" };
    }
    return { shouldMirror: true, reason: "incoming-fresher" };
}

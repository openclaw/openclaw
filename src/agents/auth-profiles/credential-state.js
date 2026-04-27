import { coerceSecretRef, normalizeSecretInputString } from "../../config/types.secrets.js";
export const DEFAULT_OAUTH_REFRESH_MARGIN_MS = 5 * 60 * 1000;
export function resolveTokenExpiryState(expires, now = Date.now(), opts) {
    if (expires === undefined) {
        return "missing";
    }
    if (typeof expires !== "number") {
        return "invalid_expires";
    }
    if (!Number.isFinite(expires) || expires <= 0) {
        return "invalid_expires";
    }
    const remainingMs = expires - now;
    if (remainingMs <= 0) {
        return "expired";
    }
    const expiringWithinMs = Math.max(0, opts?.expiringWithinMs ?? 0);
    if (expiringWithinMs > 0 && remainingMs <= expiringWithinMs) {
        return "expiring";
    }
    return "valid";
}
export function hasUsableOAuthCredential(credential, opts) {
    if (!credential || credential.type !== "oauth") {
        return false;
    }
    if (typeof credential.access !== "string" || credential.access.trim().length === 0) {
        return false;
    }
    const now = opts?.now ?? Date.now();
    const refreshMarginMs = Math.max(0, opts?.refreshMarginMs ?? DEFAULT_OAUTH_REFRESH_MARGIN_MS);
    return (resolveTokenExpiryState(credential.expires, now, {
        expiringWithinMs: refreshMarginMs,
    }) === "valid");
}
function hasConfiguredSecretRef(value) {
    return coerceSecretRef(value) !== null;
}
function hasConfiguredSecretString(value) {
    return normalizeSecretInputString(value) !== undefined;
}
export function evaluateStoredCredentialEligibility(params) {
    const now = params.now ?? Date.now();
    const credential = params.credential;
    if (credential.type === "api_key") {
        const hasKey = hasConfiguredSecretString(credential.key);
        const hasKeyRef = hasConfiguredSecretRef(credential.keyRef);
        if (!hasKey && !hasKeyRef) {
            return { eligible: false, reasonCode: "missing_credential" };
        }
        return { eligible: true, reasonCode: "ok" };
    }
    if (credential.type === "token") {
        const hasToken = hasConfiguredSecretString(credential.token);
        const hasTokenRef = hasConfiguredSecretRef(credential.tokenRef);
        if (!hasToken && !hasTokenRef) {
            return { eligible: false, reasonCode: "missing_credential" };
        }
        const expiryState = resolveTokenExpiryState(credential.expires, now);
        if (expiryState === "invalid_expires") {
            return { eligible: false, reasonCode: "invalid_expires" };
        }
        if (expiryState === "expired") {
            return { eligible: false, reasonCode: "expired" };
        }
        return { eligible: true, reasonCode: "ok" };
    }
    if (normalizeSecretInputString(credential.access) === undefined &&
        normalizeSecretInputString(credential.refresh) === undefined) {
        return { eligible: false, reasonCode: "missing_credential" };
    }
    return { eligible: true, reasonCode: "ok" };
}

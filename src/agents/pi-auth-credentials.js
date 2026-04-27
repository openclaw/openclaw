import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeProviderId } from "./provider-id.js";
export function convertAuthProfileCredentialToPi(cred) {
    if (cred.type === "api_key") {
        const key = normalizeOptionalString(cred.key) ?? "";
        if (!key) {
            return null;
        }
        return { type: "api_key", key };
    }
    if (cred.type === "token") {
        const token = normalizeOptionalString(cred.token) ?? "";
        if (!token) {
            return null;
        }
        if (typeof cred.expires === "number" &&
            Number.isFinite(cred.expires) &&
            Date.now() >= cred.expires) {
            return null;
        }
        return { type: "api_key", key: token };
    }
    if (cred.type === "oauth") {
        const access = normalizeOptionalString(cred.access) ?? "";
        const refresh = normalizeOptionalString(cred.refresh) ?? "";
        if (!access || !refresh || !Number.isFinite(cred.expires) || cred.expires <= 0) {
            return null;
        }
        return {
            type: "oauth",
            access,
            refresh,
            expires: cred.expires,
        };
    }
    return null;
}
export function resolvePiCredentialMapFromStore(store) {
    const credentials = {};
    for (const credential of Object.values(store.profiles)) {
        const provider = normalizeProviderId(credential.provider ?? "");
        if (!provider || credentials[provider]) {
            continue;
        }
        const converted = convertAuthProfileCredentialToPi(credential);
        if (converted) {
            credentials[provider] = converted;
        }
    }
    return credentials;
}
export function piCredentialsEqual(a, b) {
    if (!a || typeof a !== "object") {
        return false;
    }
    if (a.type !== b.type) {
        return false;
    }
    if (a.type === "api_key" && b.type === "api_key") {
        return a.key === b.key;
    }
    if (a.type === "oauth" && b.type === "oauth") {
        return a.access === b.access && a.refresh === b.refresh && a.expires === b.expires;
    }
    return false;
}

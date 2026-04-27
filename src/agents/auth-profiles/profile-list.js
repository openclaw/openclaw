import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
export function dedupeProfileIds(profileIds) {
    return [...new Set(profileIds)];
}
export function listProfilesForProvider(store, provider) {
    const providerKey = resolveProviderIdForAuth(provider);
    return Object.entries(store.profiles)
        .filter(([, cred]) => resolveProviderIdForAuth(cred.provider) === providerKey)
        .map(([id]) => id);
}

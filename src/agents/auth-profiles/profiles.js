import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { normalizeProviderId } from "../model-selection.js";
import { ensureAuthProfileStore, saveAuthProfileStore, updateAuthProfileStoreWithLock, } from "./store.js";
export function dedupeProfileIds(profileIds) {
    return [...new Set(profileIds)];
}
export async function setAuthProfileOrder(params) {
    const providerKey = normalizeProviderId(params.provider);
    const sanitized = params.order && Array.isArray(params.order)
        ? params.order.map((entry) => String(entry).trim()).filter(Boolean)
        : [];
    const deduped = dedupeProfileIds(sanitized);
    return await updateAuthProfileStoreWithLock({
        agentDir: params.agentDir,
        updater: (store) => {
            store.order = store.order ?? {};
            if (deduped.length === 0) {
                if (!store.order[providerKey]) {
                    return false;
                }
                delete store.order[providerKey];
                if (Object.keys(store.order).length === 0) {
                    store.order = undefined;
                }
                return true;
            }
            store.order[providerKey] = deduped;
            return true;
        },
    });
}
export function upsertAuthProfile(params) {
    const credential = params.credential.type === "api_key"
        ? {
            ...params.credential,
            ...(typeof params.credential.key === "string"
                ? { key: normalizeSecretInput(params.credential.key) }
                : {}),
        }
        : params.credential.type === "token"
            ? { ...params.credential, token: normalizeSecretInput(params.credential.token) }
            : params.credential;
    const store = ensureAuthProfileStore(params.agentDir);
    store.profiles[params.profileId] = credential;
    saveAuthProfileStore(store, params.agentDir);
}
export async function upsertAuthProfileWithLock(params) {
    return await updateAuthProfileStoreWithLock({
        agentDir: params.agentDir,
        updater: (store) => {
            store.profiles[params.profileId] = params.credential;
            return true;
        },
    });
}
export function listProfilesForProvider(store, provider) {
    const providerKey = normalizeProviderId(provider);
    return Object.entries(store.profiles)
        .filter(([, cred]) => normalizeProviderId(cred.provider) === providerKey)
        .map(([id]) => id);
}
export async function markAuthProfileGood(params) {
    const { store, provider, profileId, agentDir } = params;
    const updated = await updateAuthProfileStoreWithLock({
        agentDir,
        updater: (freshStore) => {
            const profile = freshStore.profiles[profileId];
            if (!profile || profile.provider !== provider) {
                return false;
            }
            freshStore.lastGood = { ...freshStore.lastGood, [provider]: profileId };
            return true;
        },
    });
    if (updated) {
        store.lastGood = updated.lastGood;
        return;
    }
    const profile = store.profiles[profileId];
    if (!profile || profile.provider !== provider) {
        return;
    }
    store.lastGood = { ...store.lastGood, [provider]: profileId };
    saveAuthProfileStore(store, agentDir);
}

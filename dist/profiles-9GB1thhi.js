import { r as normalizeProviderId, t as findNormalizedProviderKey } from "./provider-id-zTW9Rdln.js";
import { s as normalizeStringEntries } from "./string-normalization-DiPHgdft.js";
import { r as resolveProviderIdForAuth } from "./provider-auth-aliases-4jqi6Djx.js";
import { f as saveAuthProfileStore, p as updateAuthProfileStoreWithLock, r as ensureAuthProfileStoreForLocalUpdate } from "./store-BMQkMM4l.js";
import { n as normalizeSecretInput } from "./normalize-secret-input-CsdRhsMj.js";
import { n as listProfilesForProvider, t as dedupeProfileIds } from "./profile-list-C0HtPlut.js";
//#region src/agents/auth-profiles/profiles.ts
function resetSuccessfulUsageStats(existing, lastUsed) {
	return {
		...existing,
		errorCount: 0,
		blockedUntil: void 0,
		blockedReason: void 0,
		blockedSource: void 0,
		blockedModel: void 0,
		cooldownUntil: void 0,
		cooldownReason: void 0,
		cooldownModel: void 0,
		disabledUntil: void 0,
		disabledReason: void 0,
		failureCounts: void 0,
		lastUsed
	};
}
function updateSuccessfulUsageStatsEntry(store, profileId, lastUsed) {
	store.usageStats = store.usageStats ?? {};
	store.usageStats[profileId] = resetSuccessfulUsageStats(store.usageStats[profileId], lastUsed);
}
async function setAuthProfileOrder(params) {
	const providerKey = normalizeProviderId(params.provider);
	const deduped = dedupeProfileIds(params.order && Array.isArray(params.order) ? normalizeStringEntries(params.order) : []);
	return await updateAuthProfileStoreWithLock({
		agentDir: params.agentDir,
		updater: (store) => {
			store.order = store.order ?? {};
			if (deduped.length === 0) {
				if (!store.order[providerKey]) return false;
				delete store.order[providerKey];
				if (Object.keys(store.order).length === 0) store.order = void 0;
				return true;
			}
			store.order[providerKey] = deduped;
			return true;
		}
	});
}
async function promoteAuthProfileInOrder(params) {
	const providerKey = resolveProviderIdForAuth(params.provider);
	return await updateAuthProfileStoreWithLock({
		agentDir: params.agentDir,
		updater: (store) => {
			const profile = store.profiles[params.profileId];
			if (!profile || resolveProviderIdForAuth(profile.provider) !== providerKey) return false;
			const orderKey = findNormalizedProviderKey(store.order, providerKey) ?? normalizeProviderId(providerKey);
			const existing = store.order?.[orderKey];
			if (!existing || existing.length === 0) return false;
			const next = dedupeProfileIds([params.profileId, ...existing.filter((profileId) => profileId !== params.profileId)]);
			if (next.length === existing.length && next.every((profileId, idx) => profileId === existing[idx])) return false;
			store.order = {
				...store.order,
				[orderKey]: next
			};
			return true;
		}
	});
}
function normalizeAuthProfileCredential(credential) {
	if (credential.type === "api_key") {
		if (typeof credential.key !== "string") return credential;
		const { key: _key, ...rest } = credential;
		const key = normalizeSecretInput(credential.key);
		return {
			...rest,
			...key ? { key } : {}
		};
	}
	if (credential.type === "token") {
		if (typeof credential.token !== "string") return credential;
		const { token: _token, ...rest } = credential;
		const token = normalizeSecretInput(credential.token);
		return {
			...rest,
			...token ? { token } : {}
		};
	}
	return credential;
}
function upsertAuthProfile(params) {
	const credential = normalizeAuthProfileCredential(params.credential);
	const store = ensureAuthProfileStoreForLocalUpdate(params.agentDir);
	store.profiles[params.profileId] = credential;
	saveAuthProfileStore(store, params.agentDir, {
		filterExternalAuthProfiles: false,
		syncExternalCli: false
	});
}
async function upsertAuthProfileWithLock(params) {
	const credential = normalizeAuthProfileCredential(params.credential);
	return await updateAuthProfileStoreWithLock({
		agentDir: params.agentDir,
		saveOptions: {
			filterExternalAuthProfiles: false,
			syncExternalCli: false
		},
		updater: (store) => {
			store.profiles[params.profileId] = credential;
			return true;
		}
	});
}
async function removeProviderAuthProfilesWithLock(params) {
	const providerKey = resolveProviderIdForAuth(params.provider);
	const storeOrderKey = normalizeProviderId(params.provider);
	return await updateAuthProfileStoreWithLock({
		agentDir: params.agentDir,
		updater: (store) => {
			const profileIds = listProfilesForProvider(store, params.provider);
			let changed = false;
			for (const profileId of profileIds) {
				if (store.profiles[profileId]) {
					delete store.profiles[profileId];
					changed = true;
				}
				if (store.usageStats?.[profileId]) {
					delete store.usageStats[profileId];
					changed = true;
				}
			}
			if (store.order?.[storeOrderKey]) {
				delete store.order[storeOrderKey];
				changed = true;
				if (Object.keys(store.order).length === 0) store.order = void 0;
			}
			if (store.lastGood?.[providerKey]) {
				delete store.lastGood[providerKey];
				changed = true;
				if (Object.keys(store.lastGood).length === 0) store.lastGood = void 0;
			}
			if (store.usageStats && Object.keys(store.usageStats).length === 0) store.usageStats = void 0;
			return changed;
		}
	});
}
async function clearLastGoodProfileWithLock(params) {
	const providerKey = resolveProviderIdForAuth(params.provider);
	return await updateAuthProfileStoreWithLock({
		agentDir: params.agentDir,
		updater: (store) => {
			if (store.lastGood?.[providerKey] !== params.profileId) return false;
			delete store.lastGood[providerKey];
			if (Object.keys(store.lastGood).length === 0) store.lastGood = void 0;
			return true;
		}
	});
}
async function markAuthProfileSuccess(params) {
	const { store, provider, profileId, agentDir } = params;
	const providerKey = resolveProviderIdForAuth(provider);
	const lastUsed = Date.now();
	const updated = await updateAuthProfileStoreWithLock({
		agentDir,
		updater: (freshStore) => {
			const profile = freshStore.profiles[profileId];
			if (!profile || resolveProviderIdForAuth(profile.provider) !== providerKey) return false;
			freshStore.lastGood = {
				...freshStore.lastGood,
				[providerKey]: profileId
			};
			updateSuccessfulUsageStatsEntry(freshStore, profileId, lastUsed);
			return true;
		}
	});
	if (updated) {
		store.lastGood = updated.lastGood;
		store.usageStats = updated.usageStats;
		return;
	}
	const profile = store.profiles[profileId];
	if (!profile || resolveProviderIdForAuth(profile.provider) !== providerKey) return;
	store.lastGood = {
		...store.lastGood,
		[providerKey]: profileId
	};
	updateSuccessfulUsageStatsEntry(store, profileId, lastUsed);
	saveAuthProfileStore(store, agentDir);
}
//#endregion
export { setAuthProfileOrder as a, removeProviderAuthProfilesWithLock as i, markAuthProfileSuccess as n, upsertAuthProfile as o, promoteAuthProfileInOrder as r, upsertAuthProfileWithLock as s, clearLastGoodProfileWithLock as t };

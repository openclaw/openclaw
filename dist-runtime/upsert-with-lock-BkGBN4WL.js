import { a as withFileLock, f as AUTH_STORE_LOCK_OPTIONS, n as resolveAuthStorePath, o as loadJsonFile, s as saveJsonFile, t as ensureAuthStoreFile } from "./paths-DAoqckDF.js";
//#region src/agents/auth-profiles/upsert-with-lock.ts
function coerceAuthProfileStore(raw) {
	const record = raw && typeof raw === "object" ? raw : {};
	const profiles = record.profiles && typeof record.profiles === "object" && !Array.isArray(record.profiles) ? { ...record.profiles } : {};
	const order = record.order && typeof record.order === "object" && !Array.isArray(record.order) ? record.order : void 0;
	const lastGood = record.lastGood && typeof record.lastGood === "object" && !Array.isArray(record.lastGood) ? record.lastGood : void 0;
	const usageStats = record.usageStats && typeof record.usageStats === "object" && !Array.isArray(record.usageStats) ? record.usageStats : void 0;
	return {
		version: typeof record.version === "number" && Number.isFinite(record.version) ? record.version : 1,
		profiles,
		...order ? { order } : {},
		...lastGood ? { lastGood } : {},
		...usageStats ? { usageStats } : {}
	};
}
async function upsertAuthProfileWithLock(params) {
	const authPath = resolveAuthStorePath(params.agentDir);
	ensureAuthStoreFile(authPath);
	try {
		return await withFileLock(authPath, AUTH_STORE_LOCK_OPTIONS, async () => {
			const store = coerceAuthProfileStore(loadJsonFile(authPath));
			store.profiles[params.profileId] = params.credential;
			saveJsonFile(authPath, store);
			return store;
		});
	} catch {
		return null;
	}
}
//#endregion
export { upsertAuthProfileWithLock as t };

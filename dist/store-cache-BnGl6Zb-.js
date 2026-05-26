import { s as cloneAuthProfileStore } from "./runtime-snapshots-esDr_mQ_.js";
import "./constants-D_82oc2f.js";
//#region src/agents/auth-profiles/store-cache.ts
const loadedAuthStoreCache = /* @__PURE__ */ new Map();
function readCachedAuthProfileStore(params) {
	const cached = loadedAuthStoreCache.get(params.authPath);
	if (!cached || cached.authMtimeMs !== params.authMtimeMs || cached.stateMtimeMs !== params.stateMtimeMs) return null;
	if (Date.now() - cached.syncedAtMs >= 9e5) return null;
	return cloneAuthProfileStore(cached.store);
}
function writeCachedAuthProfileStore(params) {
	loadedAuthStoreCache.set(params.authPath, {
		authMtimeMs: params.authMtimeMs,
		stateMtimeMs: params.stateMtimeMs,
		syncedAtMs: Date.now(),
		store: cloneAuthProfileStore(params.store)
	});
}
function clearLoadedAuthStoreCache() {
	loadedAuthStoreCache.clear();
}
//#endregion
export { readCachedAuthProfileStore as n, writeCachedAuthProfileStore as r, clearLoadedAuthStoreCache as t };

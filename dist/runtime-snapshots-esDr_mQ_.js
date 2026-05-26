import { r as resolveAuthStorePath } from "./path-resolve-C6Vj5eOM.js";
//#region src/agents/auth-profiles/clone.ts
function cloneAuthProfileStore(store) {
	return JSON.parse(JSON.stringify(store, (_key, value) => {
		if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") throw new TypeError(`AuthProfileStore contains non-JSON value: ${typeof value}`);
		return value;
	}));
}
//#endregion
//#region src/agents/auth-profiles/runtime-snapshots.ts
const runtimeAuthStoreSnapshots = /* @__PURE__ */ new Map();
function resolveRuntimeStoreKey(agentDir) {
	return resolveAuthStorePath(agentDir);
}
function getRuntimeAuthProfileStoreSnapshot(agentDir) {
	const store = runtimeAuthStoreSnapshots.get(resolveRuntimeStoreKey(agentDir));
	return store ? cloneAuthProfileStore(store) : void 0;
}
function hasRuntimeAuthProfileStoreSnapshot(agentDir) {
	return runtimeAuthStoreSnapshots.has(resolveRuntimeStoreKey(agentDir));
}
function hasAnyRuntimeAuthProfileStoreSource(agentDir) {
	const requestedStore = getRuntimeAuthProfileStoreSnapshot(agentDir);
	if (requestedStore && Object.keys(requestedStore.profiles).length > 0) return true;
	if (!agentDir) return false;
	const mainStore = getRuntimeAuthProfileStoreSnapshot();
	return Boolean(mainStore && Object.keys(mainStore.profiles).length > 0);
}
function replaceRuntimeAuthProfileStoreSnapshots(entries) {
	runtimeAuthStoreSnapshots.clear();
	for (const entry of entries) runtimeAuthStoreSnapshots.set(resolveRuntimeStoreKey(entry.agentDir), cloneAuthProfileStore(entry.store));
}
function clearRuntimeAuthProfileStoreSnapshots() {
	runtimeAuthStoreSnapshots.clear();
}
function setRuntimeAuthProfileStoreSnapshot(store, agentDir) {
	runtimeAuthStoreSnapshots.set(resolveRuntimeStoreKey(agentDir), cloneAuthProfileStore(store));
}
//#endregion
export { replaceRuntimeAuthProfileStoreSnapshots as a, hasRuntimeAuthProfileStoreSnapshot as i, getRuntimeAuthProfileStoreSnapshot as n, setRuntimeAuthProfileStoreSnapshot as o, hasAnyRuntimeAuthProfileStoreSource as r, cloneAuthProfileStore as s, clearRuntimeAuthProfileStoreSnapshots as t };

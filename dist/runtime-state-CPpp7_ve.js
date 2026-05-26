import { _ as setRuntimeConfigSnapshot, t as clearRuntimeConfigSnapshot, v as setRuntimeConfigSnapshotRefreshHandler } from "./runtime-snapshot-DgdkBEdP.js";
import { a as replaceRuntimeAuthProfileStoreSnapshots, n as getRuntimeAuthProfileStoreSnapshot, t as clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots-esDr_mQ_.js";
import { t as clearLoadedAuthStoreCache } from "./store-cache-BnGl6Zb-.js";
import { r as setActiveRuntimeWebToolsMetadata, t as clearActiveRuntimeWebToolsMetadata } from "./runtime-web-tools-state-BgXXPpNN.js";
//#region src/secrets/runtime-state.ts
let activeSnapshot = null;
let activeRefreshContext = null;
const clearHooks = /* @__PURE__ */ new Set();
const preparedSnapshotRefreshContext = /* @__PURE__ */ new WeakMap();
function cloneSecretsRuntimeRefreshContext(context) {
	const cloned = {
		env: { ...context.env },
		explicitAgentDirs: context.explicitAgentDirs ? [...context.explicitAgentDirs] : null,
		includeAuthStoreRefs: context.includeAuthStoreRefs,
		loadablePluginOrigins: new Map(context.loadablePluginOrigins)
	};
	if (context.loadAuthStore) cloned.loadAuthStore = context.loadAuthStore;
	return cloned;
}
function cloneSnapshot(snapshot) {
	return {
		sourceConfig: structuredClone(snapshot.sourceConfig),
		config: structuredClone(snapshot.config),
		authStores: snapshot.authStores.map((entry) => ({
			agentDir: entry.agentDir,
			store: structuredClone(entry.store)
		})),
		warnings: snapshot.warnings.map((warning) => ({ ...warning })),
		webTools: structuredClone(snapshot.webTools)
	};
}
function setPreparedSecretsRuntimeSnapshotRefreshContext(snapshot, context) {
	preparedSnapshotRefreshContext.set(snapshot, cloneSecretsRuntimeRefreshContext(context));
}
function getPreparedSecretsRuntimeSnapshotRefreshContext(snapshot) {
	const context = preparedSnapshotRefreshContext.get(snapshot);
	return context ? cloneSecretsRuntimeRefreshContext(context) : null;
}
function getActiveSecretsRuntimeRefreshContext() {
	return activeRefreshContext ? cloneSecretsRuntimeRefreshContext(activeRefreshContext) : null;
}
function getActiveSecretsRuntimeEnv() {
	return { ...activeRefreshContext?.env ?? process.env };
}
function registerSecretsRuntimeStateClearHook(clearHook) {
	clearHooks.add(clearHook);
}
function activateSecretsRuntimeSnapshotState(params) {
	const next = cloneSnapshot(params.snapshot);
	const nextRefreshContext = params.refreshContext ? cloneSecretsRuntimeRefreshContext(params.refreshContext) : null;
	setRuntimeConfigSnapshot(next.config, next.sourceConfig);
	replaceRuntimeAuthProfileStoreSnapshots(next.authStores);
	activeSnapshot = next;
	activeRefreshContext = nextRefreshContext;
	if (nextRefreshContext) preparedSnapshotRefreshContext.set(next, cloneSecretsRuntimeRefreshContext(nextRefreshContext));
	setActiveRuntimeWebToolsMetadata(next.webTools);
	setRuntimeConfigSnapshotRefreshHandler(params.refreshHandler);
}
function getActiveSecretsRuntimeSnapshot() {
	if (!activeSnapshot) return null;
	const snapshot = cloneSnapshot(activeSnapshot);
	if (activeRefreshContext) preparedSnapshotRefreshContext.set(snapshot, cloneSecretsRuntimeRefreshContext(activeRefreshContext));
	return snapshot;
}
function getLiveSecretsRuntimeAuthStores() {
	if (!activeSnapshot) return [];
	return activeSnapshot.authStores.map((entry) => ({
		agentDir: entry.agentDir,
		store: getRuntimeAuthProfileStoreSnapshot(entry.agentDir) ?? structuredClone(entry.store)
	}));
}
function clearSecretsRuntimeSnapshot() {
	activeSnapshot = null;
	activeRefreshContext = null;
	clearActiveRuntimeWebToolsMetadata();
	setRuntimeConfigSnapshotRefreshHandler(null);
	clearRuntimeConfigSnapshot();
	clearRuntimeAuthProfileStoreSnapshots();
	clearLoadedAuthStoreCache();
	for (const clearHook of clearHooks) clearHook();
}
//#endregion
export { getActiveSecretsRuntimeSnapshot as a, registerSecretsRuntimeStateClearHook as c, getActiveSecretsRuntimeRefreshContext as i, setPreparedSecretsRuntimeSnapshotRefreshContext as l, clearSecretsRuntimeSnapshot as n, getLiveSecretsRuntimeAuthStores as o, getActiveSecretsRuntimeEnv as r, getPreparedSecretsRuntimeSnapshotRefreshContext as s, activateSecretsRuntimeSnapshotState as t };

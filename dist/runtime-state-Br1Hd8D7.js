//#region src/plugins/runtime-state.ts
const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");
function getPluginRegistryState() {
	return globalThis[PLUGIN_REGISTRY_STATE];
}
function getActivePluginRegistryWorkspaceDirFromState() {
	return getPluginRegistryState()?.workspaceDir ?? void 0;
}
//#endregion
export { getActivePluginRegistryWorkspaceDirFromState as n, getPluginRegistryState as r, PLUGIN_REGISTRY_STATE as t };

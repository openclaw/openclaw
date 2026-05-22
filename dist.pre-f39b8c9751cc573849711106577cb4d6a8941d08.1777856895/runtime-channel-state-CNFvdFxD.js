//#region src/plugins/runtime-channel-state.ts
const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");
function countChannels(registry) {
	return registry?.channels?.length ?? 0;
}
function getActivePluginChannelRegistryFromState() {
	const state = globalThis[PLUGIN_REGISTRY_STATE];
	const pinnedRegistry = state?.channel?.registry ?? null;
	if (countChannels(pinnedRegistry) > 0) return pinnedRegistry;
	const activeRegistry = state?.activeRegistry ?? null;
	if (countChannels(activeRegistry) > 0) return activeRegistry;
	return pinnedRegistry ?? activeRegistry;
}
function getActivePluginChannelRegistryVersionFromState() {
	const state = globalThis[PLUGIN_REGISTRY_STATE];
	return state?.channel?.registry ? state.channel.version ?? 0 : state?.activeVersion ?? 0;
}
//#endregion
export { getActivePluginChannelRegistryVersionFromState as n, getActivePluginChannelRegistryFromState as t };

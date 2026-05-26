//#region src/plugins/runtime-channel-state.ts
const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");
let activePluginChannelRegistrySnapshot;
function countChannels(registry) {
	return registry?.channels?.length ?? 0;
}
function getActivePluginChannelRegistrySnapshotFromState() {
	const state = globalThis[PLUGIN_REGISTRY_STATE];
	const pinnedRegistry = state?.channel?.registry ?? null;
	const activeRegistry = state?.activeRegistry ?? null;
	const pinnedChannelCount = countChannels(pinnedRegistry);
	const activeChannelCount = countChannels(activeRegistry);
	const selectedPinnedRegistry = pinnedChannelCount > 0 || pinnedRegistry !== null && activeChannelCount === 0;
	const version = selectedPinnedRegistry ? state?.channel?.version ?? 0 : state?.activeVersion ?? 0;
	const cached = activePluginChannelRegistrySnapshot;
	if (cached && cached.state === state && cached.pinnedRegistry === pinnedRegistry && cached.activeRegistry === activeRegistry && cached.pinnedChannelCount === pinnedChannelCount && cached.activeChannelCount === activeChannelCount && cached.snapshot.version === version) return cached.snapshot;
	const snapshot = {
		registry: selectedPinnedRegistry ? pinnedRegistry : activeRegistry,
		version
	};
	activePluginChannelRegistrySnapshot = {
		state,
		pinnedRegistry,
		activeRegistry,
		pinnedChannelCount,
		activeChannelCount,
		snapshot
	};
	return snapshot;
}
function getActivePluginChannelRegistryFromState() {
	return getActivePluginChannelRegistrySnapshotFromState().registry;
}
function getActivePluginChannelRegistryVersionFromState() {
	return getActivePluginChannelRegistrySnapshotFromState().version;
}
//#endregion
export { getActivePluginChannelRegistrySnapshotFromState as n, getActivePluginChannelRegistryVersionFromState as r, getActivePluginChannelRegistryFromState as t };

import { a as getActivePluginRegistry, t as getActivePluginChannelRegistry } from "./runtime-DHxRl5F1.js";
//#region src/channels/plugins/registry-loader.ts
function createChannelRegistryLoader(resolveValue) {
	return async (id) => {
		const resolveFromRegistry = (registry) => {
			const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
			return pluginEntry ? resolveValue(pluginEntry) : void 0;
		};
		const channelRegistry = getActivePluginChannelRegistry();
		const channelValue = resolveFromRegistry(channelRegistry);
		if (channelValue !== void 0) return channelValue;
		const activeRegistry = getActivePluginRegistry();
		if (activeRegistry && activeRegistry !== channelRegistry) return resolveFromRegistry(activeRegistry);
	};
}
//#endregion
//#region src/channels/plugins/outbound/load.ts
const loadOutboundAdapterFromRegistry = createChannelRegistryLoader((entry) => entry.plugin.outbound);
async function loadChannelOutboundAdapter(id) {
	return loadOutboundAdapterFromRegistry(id);
}
//#endregion
export { loadChannelOutboundAdapter as t };

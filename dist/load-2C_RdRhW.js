import { t as getActivePluginChannelRegistry } from "./runtime-CFKT2mp_.js";
//#region src/channels/plugins/registry-loader.ts
function createChannelRegistryLoader(resolveValue) {
	return async (id) => {
		const pluginEntry = getActivePluginChannelRegistry()?.channels.find((entry) => entry.plugin.id === id);
		if (!pluginEntry) return;
		return resolveValue(pluginEntry);
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

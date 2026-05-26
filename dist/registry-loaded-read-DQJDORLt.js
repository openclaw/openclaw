import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as getActivePluginChannelRegistryFromState } from "./runtime-channel-state-CQNj7c3E.js";
//#region src/channels/plugins/registry-loaded-read.ts
function coerceLoadedChannelPlugin(plugin) {
	const id = normalizeOptionalString(plugin?.id) ?? "";
	if (!plugin || !id) return;
	if (!plugin.meta || typeof plugin.meta !== "object") plugin.meta = {};
	return plugin;
}
function getLoadedChannelPluginForRead(id) {
	const resolvedId = normalizeOptionalString(id) ?? "";
	if (!resolvedId) return;
	const registry = getActivePluginChannelRegistryFromState();
	if (!registry || !Array.isArray(registry.channels)) return;
	for (const entry of registry.channels) {
		const plugin = coerceLoadedChannelPlugin(entry?.plugin);
		if (plugin && plugin.id === resolvedId) return plugin;
	}
}
//#endregion
export { getLoadedChannelPluginForRead as t };

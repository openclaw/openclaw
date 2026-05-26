import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { a as normalizeAnyChannelId } from "./registry-CtWyD2pE.js";
import { r as getBundledChannelPlugin } from "./bundled-0oTAwz0N.js";
import { n as getLoadedChannelPluginEntryById, r as listLoadedChannelPlugins, t as getLoadedChannelPluginById } from "./registry-loaded-BE-rpJc1.js";
//#region src/channels/plugins/registry.ts
function listChannelPlugins() {
	return listLoadedChannelPlugins();
}
function getLoadedChannelPlugin(id) {
	const resolvedId = normalizeOptionalString(id) ?? "";
	if (!resolvedId) return;
	return getLoadedChannelPluginById(resolvedId);
}
function getLoadedChannelPluginOrigin(id) {
	const resolvedId = normalizeOptionalString(id) ?? "";
	if (!resolvedId) return;
	return normalizeOptionalString(getLoadedChannelPluginEntryById(resolvedId)?.origin) ?? void 0;
}
function getChannelPlugin(id) {
	const resolvedId = normalizeOptionalString(id) ?? "";
	if (!resolvedId) return;
	return getLoadedChannelPlugin(resolvedId) ?? getBundledChannelPlugin(resolvedId);
}
function normalizeChannelId(raw) {
	return normalizeAnyChannelId(raw);
}
//#endregion
export { normalizeChannelId as a, listChannelPlugins as i, getLoadedChannelPlugin as n, getLoadedChannelPluginOrigin as r, getChannelPlugin as t };

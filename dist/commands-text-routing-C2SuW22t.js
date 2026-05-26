import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { g as requireActivePluginChannelRegistry, n as getActivePluginChannelRegistryVersion } from "./runtime-DHxRl5F1.js";
import { i as listChannelPlugins } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
//#region src/auto-reply/commands-text-routing.ts
let cachedNativeCommandSurfaces = null;
let cachedNativeCommandSurfacesVersion = -1;
let cachedNativeCommandSurfacesRegistry = null;
function isNativeCommandSurface(surface) {
	const normalized = normalizeOptionalLowercaseString(surface);
	if (!normalized) return false;
	const activeRegistry = requireActivePluginChannelRegistry();
	const registryVersion = getActivePluginChannelRegistryVersion();
	if (!cachedNativeCommandSurfaces || cachedNativeCommandSurfacesVersion !== registryVersion || cachedNativeCommandSurfacesRegistry !== activeRegistry) {
		cachedNativeCommandSurfaces = new Set(listChannelPlugins().filter((plugin) => plugin.capabilities?.nativeCommands === true).map((plugin) => plugin.id));
		cachedNativeCommandSurfacesVersion = registryVersion;
		cachedNativeCommandSurfacesRegistry = activeRegistry;
	}
	return cachedNativeCommandSurfaces.has(normalized);
}
function shouldHandleTextCommands(params) {
	if (params.commandSource === "native") return true;
	if (params.cfg.commands?.text !== false) return true;
	return !isNativeCommandSurface(params.surface);
}
//#endregion
export { shouldHandleTextCommands as n, isNativeCommandSurface as t };

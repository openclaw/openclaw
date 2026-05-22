import { o as normalizePluginsConfig } from "./config-state-6n1ivR82.js";
import { s as getMemoryRuntime } from "./memory-state-BjCWnlv2.js";
import { n as getLoadedRuntimePluginRegistry } from "./active-runtime-registry-E0P-GaIt.js";
//#region src/plugins/memory-runtime.ts
function resolveMemoryRuntimePluginIds(config) {
	const memorySlot = normalizePluginsConfig(config.plugins).slots.memory;
	return typeof memorySlot === "string" && memorySlot.trim().length > 0 ? [memorySlot] : [];
}
function ensureMemoryRuntime(cfg) {
	const current = getMemoryRuntime();
	if (current || !cfg) return current;
	const onlyPluginIds = resolveMemoryRuntimePluginIds(cfg);
	if (onlyPluginIds.length === 0) return getMemoryRuntime();
	getLoadedRuntimePluginRegistry({ requiredPluginIds: onlyPluginIds });
	return getMemoryRuntime();
}
async function getActiveMemorySearchManager(params) {
	const runtime = ensureMemoryRuntime(params.cfg);
	if (!runtime) return {
		manager: null,
		error: "memory plugin unavailable"
	};
	return await runtime.getMemorySearchManager(params);
}
function resolveActiveMemoryBackendConfig(params) {
	return ensureMemoryRuntime(params.cfg)?.resolveMemoryBackendConfig(params) ?? null;
}
async function closeActiveMemorySearchManagers(cfg) {
	await getMemoryRuntime()?.closeAllMemorySearchManagers?.();
}
//#endregion
export { getActiveMemorySearchManager as n, resolveActiveMemoryBackendConfig as r, closeActiveMemorySearchManagers as t };

import { t as loadPluginManifestRegistry } from "./manifest-registry-CijNIx3M.js";
import { t as createSubsystemLogger } from "./subsystem-BjA1KmGE.js";
import { l as loadOpenClawPlugins } from "./loader-C51Fd3z8.js";
import { a as normalizeAgentToolResultMiddlewareRuntimeIds, i as listAgentToolResultMiddlewares } from "./tool-contracts-BWOY9TKv.js";
import { n as getLoadedRuntimePluginRegistry } from "./active-runtime-registry-DxwiZseU.js";
//#region src/plugins/agent-tool-result-middleware-loader.ts
const log = createSubsystemLogger("plugins/agent-tool-result-middleware");
async function resolveRuntimeConfig() {
	const { getRuntimeConfig } = await import("./config/config.js");
	return getRuntimeConfig();
}
function listMiddlewareOwnerPluginIds(params) {
	const pluginIds = [];
	for (const record of params.manifestRegistry.plugins) {
		if (record.origin !== "bundled") continue;
		if (normalizeAgentToolResultMiddlewareRuntimeIds(record.contracts?.agentToolResultMiddleware).includes(params.runtime) && !pluginIds.includes(record.id)) pluginIds.push(record.id);
	}
	return pluginIds;
}
async function loadAgentToolResultMiddlewaresForRuntime(params) {
	const activeHandlers = listAgentToolResultMiddlewares(params.runtime);
	if (activeHandlers.length > 0) return activeHandlers;
	try {
		const config = params.config ?? await resolveRuntimeConfig();
		const env = params.env ?? process.env;
		const manifestRegistry = params.manifestRegistry ?? loadPluginManifestRegistry({
			config,
			workspaceDir: params.workspaceDir,
			env
		});
		const pluginIds = listMiddlewareOwnerPluginIds({
			manifestRegistry,
			runtime: params.runtime
		});
		if (pluginIds.length === 0) return [];
		return (getLoadedRuntimePluginRegistry({
			workspaceDir: params.workspaceDir,
			env,
			requiredPluginIds: pluginIds
		}) ?? loadOpenClawPlugins({
			config,
			workspaceDir: params.workspaceDir,
			env,
			onlyPluginIds: pluginIds,
			manifestRegistry,
			activate: false
		})).agentToolResultMiddlewares.filter((entry) => entry.runtimes.includes(params.runtime)).map((entry) => entry.handler);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		log.warn(`[${params.runtime}] failed to load tool result middleware plugins: ${detail}`);
		return listAgentToolResultMiddlewares(params.runtime);
	}
}
//#endregion
export { loadAgentToolResultMiddlewaresForRuntime };

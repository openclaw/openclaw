import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { v as getCurrentPluginMetadataSnapshot } from "./plugin-registry-CgH_ZSlH.js";
import { l as getActivePluginRuntimeSubagentMode } from "./runtime-DHxRl5F1.js";
import { t as ensureStandaloneRuntimePluginRegistryLoaded } from "./standalone-runtime-registry-loader-B16U68P-.js";
//#region src/agents/runtime-plugins.ts
function resolveStartupPluginIdsFromCurrentSnapshot(params) {
	const pluginIds = getCurrentPluginMetadataSnapshot({
		config: params.config,
		workspaceDir: params.workspaceDir
	})?.startup?.pluginIds;
	if (!Array.isArray(pluginIds)) return;
	return pluginIds.filter((pluginId) => typeof pluginId === "string");
}
function ensureRuntimePluginsLoaded(params) {
	const workspaceDir = typeof params.workspaceDir === "string" && params.workspaceDir.trim() ? resolveUserPath(params.workspaceDir) : void 0;
	const startupPluginIds = resolveStartupPluginIdsFromCurrentSnapshot({
		config: params.config,
		workspaceDir
	});
	const allowGatewaySubagentBinding = params.allowGatewaySubagentBinding === true || getActivePluginRuntimeSubagentMode() === "gateway-bindable";
	ensureStandaloneRuntimePluginRegistryLoaded({
		requiredPluginIds: startupPluginIds,
		loadOptions: {
			config: params.config,
			workspaceDir,
			...startupPluginIds === void 0 ? {} : { onlyPluginIds: startupPluginIds },
			runtimeOptions: allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : void 0
		}
	});
}
//#endregion
export { ensureRuntimePluginsLoaded as t };

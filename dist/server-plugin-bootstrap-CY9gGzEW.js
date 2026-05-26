import { t as applyPluginAutoEnable } from "./plugin-auto-enable-DLIxCAM0.js";
import { d as pinActivePluginChannelRegistry } from "./runtime-CFKT2mp_.js";
import { i as loadGatewayPlugins, n as createGatewaySubagentRuntime, o as setPluginSubagentOverridePolicies, t as createGatewayNodesRuntime } from "./server-plugins-BFB8Y6GY.js";
import { t as primeConfiguredBindingRegistry } from "./binding-registry-CljyPxAO.js";
import { i as setGatewaySubagentRuntime, r as setGatewayNodesRuntime } from "./gateway-bindings-BAQ18VVz.js";
import { t as mergeActivationSectionsIntoRuntimeConfig } from "./plugin-activation-runtime-config-D4M3xPcL.js";
//#region src/gateway/server-plugin-bootstrap.ts
function installGatewayPluginRuntimeEnvironment(cfg) {
	setPluginSubagentOverridePolicies(cfg);
	setGatewaySubagentRuntime(createGatewaySubagentRuntime());
	setGatewayNodesRuntime(createGatewayNodesRuntime());
}
function logGatewayPluginDiagnostics(params) {
	for (const diag of params.diagnostics) {
		const details = [diag.pluginId ? `plugin=${diag.pluginId}` : null, diag.source ? `source=${diag.source}` : null].filter((entry) => Boolean(entry)).join(", ");
		const message = details ? `[plugins] ${diag.message} (${details})` : `[plugins] ${diag.message}`;
		if (diag.level === "error") params.log.error(message);
		else params.log.info(message);
	}
}
function prepareGatewayPluginLoad(params) {
	const activationSourceConfig = params.activationSourceConfig ?? params.cfg;
	const autoEnabled = applyPluginAutoEnable({
		config: activationSourceConfig,
		env: process.env,
		...params.pluginLookUpTable?.manifestRegistry ? { manifestRegistry: params.pluginLookUpTable.manifestRegistry } : {}
	});
	const resolvedConfig = activationSourceConfig === params.cfg ? autoEnabled.config : mergeActivationSectionsIntoRuntimeConfig({
		runtimeConfig: params.cfg,
		activationConfig: autoEnabled.config
	});
	installGatewayPluginRuntimeEnvironment(resolvedConfig);
	const loaded = loadGatewayPlugins({
		cfg: resolvedConfig,
		activationSourceConfig,
		autoEnabledReasons: autoEnabled.autoEnabledReasons,
		workspaceDir: params.workspaceDir,
		log: params.log,
		...params.coreGatewayHandlers !== void 0 && { coreGatewayHandlers: params.coreGatewayHandlers },
		...params.coreGatewayMethodNames !== void 0 && { coreGatewayMethodNames: params.coreGatewayMethodNames },
		...params.hostServices !== void 0 && { hostServices: params.hostServices },
		baseMethods: params.baseMethods,
		pluginIds: params.pluginIds,
		pluginLookUpTable: params.pluginLookUpTable,
		preferSetupRuntimeForChannelPlugins: params.preferSetupRuntimeForChannelPlugins,
		suppressPluginInfoLogs: params.suppressPluginInfoLogs,
		startupTrace: params.startupTrace
	});
	params.beforePrimeRegistry?.(loaded.pluginRegistry);
	primeConfiguredBindingRegistry({ cfg: resolvedConfig });
	if ((params.logDiagnostics ?? true) && loaded.pluginRegistry.diagnostics.length > 0) logGatewayPluginDiagnostics({
		diagnostics: loaded.pluginRegistry.diagnostics,
		log: params.log
	});
	return loaded;
}
function loadGatewayStartupPlugins(params) {
	return prepareGatewayPluginLoad({
		...params,
		beforePrimeRegistry: pinActivePluginChannelRegistry
	});
}
function reloadDeferredGatewayPlugins(params) {
	return prepareGatewayPluginLoad({
		...params,
		beforePrimeRegistry: pinActivePluginChannelRegistry
	});
}
//#endregion
export { loadGatewayStartupPlugins, prepareGatewayPluginLoad, reloadDeferredGatewayPlugins };

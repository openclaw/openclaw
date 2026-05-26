import "./agent-scope-CtLXGcWm.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { s as listCoreGatewayMethodNames } from "./core-descriptors-zcE5f_RQ.js";
import { t as applyPluginAutoEnable } from "./plugin-auto-enable-CuCUT4Z1.js";
import "./loader-DKK7Ita0.js";
import { F as createEmptyPluginRegistry, a as getActivePluginRegistry, x as setActivePluginRegistry } from "./runtime-DHxRl5F1.js";
import { t as loadPluginLookUpTable } from "./plugin-lookup-table-CWObPlB3.js";
import { c as initSubagentRegistry } from "./subagent-registry-QwuPQSxK.js";
import { t as mergeActivationSectionsIntoRuntimeConfig } from "./plugin-activation-runtime-config-BW4ndACs.js";
import { n as listGatewayMethods } from "./server-methods-list-DSjj8sa9.js";
//#region src/gateway/server-startup-plugins.ts
function resolveGatewayStartupMaintenanceConfig(params) {
	return params.cfgAtStart.channels === void 0 && params.startupRuntimeConfig.channels !== void 0 ? {
		...params.cfgAtStart,
		channels: params.startupRuntimeConfig.channels
	} : params.cfgAtStart;
}
async function prepareGatewayPluginBootstrap(params) {
	const activationSourceConfig = params.activationSourceConfig ?? params.cfgAtStart;
	const startupMaintenanceConfig = resolveGatewayStartupMaintenanceConfig({
		cfgAtStart: params.cfgAtStart,
		startupRuntimeConfig: params.startupRuntimeConfig
	});
	if (!params.minimalTestGateway || startupMaintenanceConfig.channels !== void 0) {
		const { runChannelPluginStartupMaintenance } = await import("./lifecycle-startup-BseLwyqz.js");
		const startupTasks = [runChannelPluginStartupMaintenance({
			cfg: startupMaintenanceConfig,
			env: process.env,
			log: params.log
		})];
		if (!params.minimalTestGateway) {
			const { runStartupSessionMigration } = await import("./server-startup-session-migration-CYGL7sCv.js");
			startupTasks.push(runStartupSessionMigration({
				cfg: params.cfgAtStart,
				env: process.env,
				log: params.log
			}));
		}
		await Promise.all(startupTasks);
	}
	initSubagentRegistry();
	const gatewayPluginConfig = params.minimalTestGateway ? params.cfgAtStart : mergeActivationSectionsIntoRuntimeConfig({
		runtimeConfig: params.cfgAtStart,
		activationConfig: applyPluginAutoEnable({
			config: activationSourceConfig,
			env: process.env,
			...params.pluginMetadataSnapshot?.manifestRegistry ? { manifestRegistry: params.pluginMetadataSnapshot.manifestRegistry } : {}
		}).config
	});
	const pluginsGloballyDisabled = gatewayPluginConfig.plugins?.enabled === false;
	const defaultWorkspaceDir = resolveAgentWorkspaceDir(gatewayPluginConfig, resolveDefaultAgentId(gatewayPluginConfig));
	const pluginLookUpTable = params.minimalTestGateway || pluginsGloballyDisabled ? void 0 : loadPluginLookUpTable({
		config: gatewayPluginConfig,
		workspaceDir: defaultWorkspaceDir,
		env: process.env,
		activationSourceConfig,
		metadataSnapshot: params.pluginMetadataSnapshot
	});
	const deferredConfiguredChannelPluginIds = [...pluginLookUpTable?.startup.configuredDeferredChannelPluginIds ?? []];
	const startupPluginIds = [...pluginLookUpTable?.startup.pluginIds ?? []];
	const baseMethods = listGatewayMethods();
	const coreGatewayMethodNames = listCoreGatewayMethodNames();
	const emptyPluginRegistry = createEmptyPluginRegistry();
	let pluginRegistry = emptyPluginRegistry;
	let baseGatewayMethods = baseMethods;
	const shouldLoadRuntimePlugins = params.loadRuntimePlugins !== false;
	if (!params.minimalTestGateway && shouldLoadRuntimePlugins) ({pluginRegistry, gatewayMethods: baseGatewayMethods} = await loadGatewayStartupPluginRuntime({
		cfg: gatewayPluginConfig,
		activationSourceConfig,
		workspaceDir: defaultWorkspaceDir,
		log: params.log,
		baseMethods,
		coreGatewayMethodNames,
		startupPluginIds,
		pluginLookUpTable,
		preferSetupRuntimeForChannelPlugins: deferredConfiguredChannelPluginIds.length > 0,
		suppressPluginInfoLogs: deferredConfiguredChannelPluginIds.length > 0
	}));
	else {
		pluginRegistry = params.minimalTestGateway ? getActivePluginRegistry() ?? emptyPluginRegistry : emptyPluginRegistry;
		setActivePluginRegistry(pluginRegistry);
	}
	return {
		gatewayPluginConfigAtStart: gatewayPluginConfig,
		defaultWorkspaceDir,
		deferredConfiguredChannelPluginIds,
		startupPluginIds,
		pluginLookUpTable,
		baseMethods,
		pluginRegistry,
		baseGatewayMethods,
		runtimePluginsLoaded: !params.minimalTestGateway && shouldLoadRuntimePlugins
	};
}
async function loadGatewayStartupPluginRuntime(params) {
	const { loadGatewayStartupPlugins } = await import("./server-plugin-bootstrap-Cf8Io8s6.js");
	return loadGatewayStartupPlugins({
		cfg: params.cfg,
		activationSourceConfig: params.activationSourceConfig,
		workspaceDir: params.workspaceDir,
		log: params.log,
		coreGatewayMethodNames: params.coreGatewayMethodNames ?? params.baseMethods,
		baseMethods: params.baseMethods,
		...params.hostServices !== void 0 && { hostServices: params.hostServices },
		pluginIds: params.startupPluginIds,
		pluginLookUpTable: params.pluginLookUpTable,
		preferSetupRuntimeForChannelPlugins: params.preferSetupRuntimeForChannelPlugins,
		suppressPluginInfoLogs: params.suppressPluginInfoLogs,
		startupTrace: params.startupTrace
	});
}
//#endregion
export { loadGatewayStartupPluginRuntime, prepareGatewayPluginBootstrap, resolveGatewayStartupMaintenanceConfig };

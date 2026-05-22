import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-DKR4wP5w.js";
import "./agent-scope-ByE5d_BM.js";
import { t as applyPluginAutoEnable } from "./plugin-auto-enable-CvCA1U8E.js";
import "./loader-BW9hyS7Z.js";
import { P as createEmptyPluginRegistry, a as getActivePluginRegistry, x as setActivePluginRegistry } from "./runtime-DLcM2w72.js";
import { c as initSubagentRegistry } from "./subagent-registry-BEKwk_2h.js";
import { t as mergeActivationSectionsIntoRuntimeConfig } from "./plugin-activation-runtime-config-BtFgSvCB.js";
import { t as loadPluginLookUpTable } from "./plugin-lookup-table-uQtK5M_3.js";
import { n as listGatewayMethods } from "./server-methods-list-Dyep7ZFU.js";
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
		const { runChannelPluginStartupMaintenance } = await import("./lifecycle-startup-cgtVP661.js");
		const startupTasks = [runChannelPluginStartupMaintenance({
			cfg: startupMaintenanceConfig,
			env: process.env,
			log: params.log
		})];
		if (!params.minimalTestGateway) {
			const { runStartupSessionMigration } = await import("./server-startup-session-migration-BCsxtmqh.js");
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
	const { loadGatewayStartupPlugins } = await import("./server-plugin-bootstrap-sAecMX9a.js");
	return loadGatewayStartupPlugins({
		cfg: params.cfg,
		activationSourceConfig: params.activationSourceConfig,
		workspaceDir: params.workspaceDir,
		log: params.log,
		coreGatewayMethodNames: params.baseMethods,
		baseMethods: params.baseMethods,
		pluginIds: params.startupPluginIds,
		pluginLookUpTable: params.pluginLookUpTable,
		preferSetupRuntimeForChannelPlugins: params.preferSetupRuntimeForChannelPlugins,
		suppressPluginInfoLogs: params.suppressPluginInfoLogs,
		startupTrace: params.startupTrace
	});
}
//#endregion
export { loadGatewayStartupPluginRuntime, prepareGatewayPluginBootstrap, resolveGatewayStartupMaintenanceConfig };

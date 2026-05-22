import { t as createSubsystemLogger } from "./subsystem-CgTF-J8V.js";
import { t as PLUGIN_REGISTRY_STATE } from "./runtime-state-Bl--3hON.js";
import { l as onAgentEvent } from "./agent-events-CoDXyyM4.js";
import { i as dispatchPluginAgentEventSubscriptions, n as clearPluginHostRuntimeState } from "./host-hook-runtime-DiP9En9h.js";
//#region src/plugins/registry-empty.ts
function createEmptyPluginRegistry() {
	return {
		plugins: [],
		tools: [],
		hooks: [],
		typedHooks: [],
		channels: [],
		channelSetups: [],
		providers: [],
		cliBackends: [],
		textTransforms: [],
		speechProviders: [],
		realtimeTranscriptionProviders: [],
		realtimeVoiceProviders: [],
		mediaUnderstandingProviders: [],
		imageGenerationProviders: [],
		videoGenerationProviders: [],
		musicGenerationProviders: [],
		webFetchProviders: [],
		webSearchProviders: [],
		migrationProviders: [],
		codexAppServerExtensionFactories: [],
		agentToolResultMiddlewares: [],
		memoryEmbeddingProviders: [],
		agentHarnesses: [],
		gatewayHandlers: {},
		coreGatewayMethodNames: [],
		gatewayMethodScopes: {},
		httpRoutes: [],
		cliRegistrars: [],
		reloads: [],
		nodeHostCommands: [],
		nodeInvokePolicies: [],
		securityAuditCollectors: [],
		services: [],
		gatewayDiscoveryServices: [],
		commands: [],
		sessionExtensions: [],
		trustedToolPolicies: [],
		toolMetadata: [],
		controlUiDescriptors: [],
		runtimeLifecycles: [],
		agentEventSubscriptions: [],
		sessionSchedulerJobs: [],
		conversationBindingResolvedHandlers: [],
		diagnostics: []
	};
}
//#endregion
//#region src/plugins/runtime.ts
const log = createSubsystemLogger("plugins/runtime");
function asPluginRegistry(registry) {
	return registry;
}
const state = (() => {
	const globalState = globalThis;
	let registryState = globalState[PLUGIN_REGISTRY_STATE];
	if (!registryState) {
		registryState = {
			activeRegistry: null,
			activeVersion: 0,
			httpRoute: {
				registry: null,
				pinned: false,
				version: 0
			},
			channel: {
				registry: null,
				pinned: false,
				version: 0
			},
			key: null,
			workspaceDir: null,
			runtimeSubagentMode: "default",
			importedPluginIds: /* @__PURE__ */ new Set()
		};
		globalState[PLUGIN_REGISTRY_STATE] = registryState;
	}
	return registryState;
})();
let pluginAgentEventUnsubscribe;
function registryHasPluginHostCleanupWork(registry) {
	if (!registry) return false;
	return registry.plugins.some((plugin) => plugin.status === "loaded") || (registry.sessionExtensions?.length ?? 0) > 0 || (registry.runtimeLifecycles?.length ?? 0) > 0 || (registry.agentEventSubscriptions?.length ?? 0) > 0 || (registry.sessionSchedulerJobs?.length ?? 0) > 0;
}
async function cleanupPreviousPluginHostRegistry(params) {
	const [{ getRuntimeConfig }, { cleanupReplacedPluginHostRegistry }] = await Promise.all([import("./config/config.js"), import("./host-hook-cleanup-D4wR7zY4.js")]);
	await cleanupReplacedPluginHostRegistry({
		cfg: getRuntimeConfig(),
		previousRegistry: params.previousRegistry,
		nextRegistry: params.nextRegistry
	});
}
function syncPluginAgentEventBridge(registry) {
	pluginAgentEventUnsubscribe?.();
	pluginAgentEventUnsubscribe = void 0;
	if (!registry) return;
	pluginAgentEventUnsubscribe = onAgentEvent((event) => {
		dispatchPluginAgentEventSubscriptions({
			registry: state.activeRegistry,
			event
		});
	});
}
function recordImportedPluginId(pluginId) {
	state.importedPluginIds.add(pluginId);
}
function installSurfaceRegistry(surface, registry, pinned) {
	if (surface.registry === registry && surface.pinned === pinned) return;
	surface.registry = registry;
	surface.pinned = pinned;
	surface.version += 1;
}
function syncTrackedSurface(surface, registry, refreshVersion = false) {
	if (surface.pinned) return;
	if (surface.registry === registry && !surface.pinned) {
		if (refreshVersion) surface.version += 1;
		return;
	}
	installSurfaceRegistry(surface, registry, false);
}
function setActivePluginRegistry(registry, cacheKey, runtimeSubagentMode = "default", workspaceDir) {
	const previousRegistry = asPluginRegistry(state.activeRegistry);
	state.activeRegistry = registry;
	state.activeVersion += 1;
	syncTrackedSurface(state.httpRoute, registry, true);
	syncTrackedSurface(state.channel, registry, true);
	state.key = cacheKey ?? null;
	state.workspaceDir = workspaceDir ?? null;
	state.runtimeSubagentMode = runtimeSubagentMode;
	syncPluginAgentEventBridge(registry);
	if (!previousRegistry || previousRegistry === registry || !registryHasPluginHostCleanupWork(previousRegistry)) return;
	cleanupPreviousPluginHostRegistry({
		previousRegistry,
		nextRegistry: registry
	}).catch((error) => {
		log.warn(`plugin host registry cleanup failed: ${String(error)}`);
	});
}
function getActivePluginRegistry() {
	return asPluginRegistry(state.activeRegistry);
}
function getActivePluginRegistryWorkspaceDir() {
	return state.workspaceDir ?? void 0;
}
function requireActivePluginRegistry() {
	if (!state.activeRegistry) {
		state.activeRegistry = createEmptyPluginRegistry();
		state.activeVersion += 1;
		syncTrackedSurface(state.httpRoute, state.activeRegistry);
		syncTrackedSurface(state.channel, state.activeRegistry);
	}
	return asPluginRegistry(state.activeRegistry);
}
function pinActivePluginHttpRouteRegistry(registry) {
	installSurfaceRegistry(state.httpRoute, registry, true);
}
function releasePinnedPluginHttpRouteRegistry(registry) {
	if (registry && state.httpRoute.registry !== registry) return;
	installSurfaceRegistry(state.httpRoute, state.activeRegistry, false);
}
function getActivePluginHttpRouteRegistry() {
	return asPluginRegistry(state.httpRoute.registry ?? state.activeRegistry);
}
function getActivePluginHttpRouteRegistryVersion() {
	return state.httpRoute.registry ? state.httpRoute.version : state.activeVersion;
}
function requireActivePluginHttpRouteRegistry() {
	const existing = getActivePluginHttpRouteRegistry();
	if (existing) return existing;
	const created = requireActivePluginRegistry();
	installSurfaceRegistry(state.httpRoute, created, false);
	return created;
}
function resolveActivePluginHttpRouteRegistry(fallback) {
	const routeRegistry = getActivePluginHttpRouteRegistry();
	if (!routeRegistry) return fallback;
	if (state.httpRoute.pinned) return routeRegistry;
	const routeCount = routeRegistry.httpRoutes?.length ?? 0;
	const fallbackRouteCount = fallback.httpRoutes?.length ?? 0;
	if (routeCount === 0 && fallbackRouteCount > 0) return fallback;
	return routeRegistry;
}
/** Pin the channel registry so that subsequent `setActivePluginRegistry` calls
*  do not replace the channel snapshot used by `getChannelPlugin`. Call at
*  gateway startup after the initial plugin load so that config-schema reads
*  and other non-primary registry loads cannot evict channel plugins. */
function pinActivePluginChannelRegistry(registry) {
	installSurfaceRegistry(state.channel, registry, true);
}
function releasePinnedPluginChannelRegistry(registry) {
	if (registry && state.channel.registry !== registry) return;
	installSurfaceRegistry(state.channel, state.activeRegistry, false);
}
/** Return the registry that should be used for channel plugin resolution.
*  When pinned, this returns the startup registry regardless of subsequent
*  `setActivePluginRegistry` calls. */
function getActivePluginChannelRegistry() {
	return asPluginRegistry(state.channel.registry ?? state.activeRegistry);
}
function getActivePluginChannelRegistryVersion() {
	return state.channel.registry ? state.channel.version : state.activeVersion;
}
function requireActivePluginChannelRegistry() {
	const existing = getActivePluginChannelRegistry();
	if (existing) return existing;
	const created = requireActivePluginRegistry();
	installSurfaceRegistry(state.channel, created, false);
	return created;
}
function getActivePluginRegistryKey() {
	return state.key;
}
function getActivePluginRuntimeSubagentMode() {
	return state.runtimeSubagentMode;
}
function getActivePluginRegistryVersion() {
	return state.activeVersion;
}
function collectLoadedPluginIds(registry, ids) {
	if (!registry) return;
	for (const plugin of registry.plugins) if (plugin.status === "loaded" && plugin.format !== "bundle") ids.add(plugin.id);
}
/**
* Returns plugin ids that were imported by plugin runtime or registry loading in
* the current process.
*
* This is a process-level view, not a fresh import trace: cached registry reuse
* still counts because the plugin code was loaded earlier in this process.
* Explicit loader import tracking covers plugins that were imported but later
* ended in an error state during registration.
* Bundle-format plugins are excluded because they can be "loaded" from metadata
* without importing any JS entrypoint.
*/
function listImportedRuntimePluginIds() {
	const imported = new Set(state.importedPluginIds);
	collectLoadedPluginIds(asPluginRegistry(state.activeRegistry), imported);
	collectLoadedPluginIds(asPluginRegistry(state.channel.registry), imported);
	collectLoadedPluginIds(asPluginRegistry(state.httpRoute.registry), imported);
	return [...imported].toSorted((left, right) => left.localeCompare(right));
}
function resetPluginRuntimeStateForTest() {
	state.activeRegistry = null;
	state.activeVersion += 1;
	installSurfaceRegistry(state.httpRoute, null, false);
	installSurfaceRegistry(state.channel, null, false);
	state.key = null;
	state.workspaceDir = null;
	state.runtimeSubagentMode = "default";
	state.importedPluginIds.clear();
	syncPluginAgentEventBridge(null);
	clearPluginHostRuntimeState();
}
//#endregion
export { createEmptyPluginRegistry as S, requireActivePluginHttpRouteRegistry as _, getActivePluginRegistry as a, resolveActivePluginHttpRouteRegistry as b, getActivePluginRegistryWorkspaceDir as c, pinActivePluginChannelRegistry as d, pinActivePluginHttpRouteRegistry as f, requireActivePluginChannelRegistry as g, releasePinnedPluginHttpRouteRegistry as h, getActivePluginHttpRouteRegistryVersion as i, getActivePluginRuntimeSubagentMode as l, releasePinnedPluginChannelRegistry as m, getActivePluginChannelRegistryVersion as n, getActivePluginRegistryKey as o, recordImportedPluginId as p, getActivePluginHttpRouteRegistry as r, getActivePluginRegistryVersion as s, getActivePluginChannelRegistry as t, listImportedRuntimePluginIds as u, requireActivePluginRegistry as v, setActivePluginRegistry as x, resetPluginRuntimeStateForTest as y };

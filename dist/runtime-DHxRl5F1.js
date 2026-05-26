import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { n as resolveGlobalSingleton } from "./global-singleton-DE6St75u.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { t as PLUGIN_REGISTRY_STATE } from "./runtime-state-DRIYGASz.js";
import { n as getActivePluginChannelRegistrySnapshotFromState } from "./runtime-channel-state-CQNj7c3E.js";
import { l as onAgentEvent } from "./agent-events-BuYtWSh4.js";
import { t as isPluginJsonValue } from "./host-hook-json-BHsxXV1L.js";
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
		modelCatalogProviders: [],
		cliBackends: [],
		textTransforms: [],
		embeddingProviders: [],
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
		gatewayMethodDescriptors: [],
		coreGatewayMethodNames: [],
		httpRoutes: [],
		hostedMediaResolvers: [],
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
		sessionActions: [],
		conversationBindingResolvedHandlers: [],
		diagnostics: []
	};
}
//#endregion
//#region src/plugins/host-hooks.ts
function normalizePluginHostHookId(value) {
	return (value ?? "").trim();
}
function normalizeQueuedInjectionText(entry, placement) {
	const candidate = entry;
	if (candidate.placement !== placement || typeof candidate.text !== "string") return;
	return candidate.text.trim() || void 0;
}
function buildPluginAgentTurnPrepareContext(params) {
	const prepend = params.queuedInjections.map((entry) => normalizeQueuedInjectionText(entry, "prepend_context")).filter(Boolean);
	const append = params.queuedInjections.map((entry) => normalizeQueuedInjectionText(entry, "append_context")).filter(Boolean);
	return {
		...prepend.length > 0 ? { prependContext: prepend.join("\n\n") } : {},
		...append.length > 0 ? { appendContext: append.join("\n\n") } : {}
	};
}
//#endregion
//#region src/plugins/host-hook-cleanup-timeout.ts
const PLUGIN_HOST_CLEANUP_TIMEOUT_MS = 5e3;
var PluginHostCleanupTimeoutError = class extends Error {
	constructor(hookId) {
		super(`plugin host cleanup timed out: ${hookId}`);
		this.name = "PluginHostCleanupTimeoutError";
	}
};
async function withPluginHostCleanupTimeout(hookId, cleanup) {
	let timeout;
	try {
		return await Promise.race([Promise.resolve().then(cleanup), new Promise((_, reject) => {
			timeout = setTimeout(() => {
				reject(new PluginHostCleanupTimeoutError(hookId));
			}, PLUGIN_HOST_CLEANUP_TIMEOUT_MS);
			timeout.unref?.();
		})]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
//#endregion
//#region src/plugins/host-hook-runtime.ts
const PLUGIN_HOST_RUNTIME_STATE_KEY = Symbol.for("openclaw.pluginHostRuntimeState");
const CLOSED_RUN_IDS_MAX = 512;
const PLUGIN_TERMINAL_EVENT_CLEANUP_WAIT_MS = 5e3;
const log$1 = createSubsystemLogger("plugins/host-hooks");
function getPluginHostRuntimeState() {
	return resolveGlobalSingleton(PLUGIN_HOST_RUNTIME_STATE_KEY, () => ({
		runContextByRunId: /* @__PURE__ */ new Map(),
		schedulerJobsByPlugin: /* @__PURE__ */ new Map(),
		nextSchedulerJobGeneration: 1,
		pendingAgentEventHandlersByRunId: /* @__PURE__ */ new Map(),
		closedRunIds: /* @__PURE__ */ new Set(),
		terminalEventCleanupExpiredRunIds: /* @__PURE__ */ new Set()
	}));
}
function normalizeNamespace(value) {
	return (value ?? "").trim();
}
function copyJsonValue(value) {
	return structuredClone(value);
}
function markPluginRunClosed(runId) {
	const state = getPluginHostRuntimeState();
	state.closedRunIds.delete(runId);
	state.closedRunIds.add(runId);
	while (state.closedRunIds.size > CLOSED_RUN_IDS_MAX) {
		const oldest = state.closedRunIds.values().next().value;
		if (oldest === void 0) break;
		state.closedRunIds.delete(oldest);
	}
}
function isPluginRunClosed(runId) {
	return getPluginHostRuntimeState().closedRunIds.has(runId);
}
function markTerminalEventCleanupExpired(runId) {
	const state = getPluginHostRuntimeState();
	state.terminalEventCleanupExpiredRunIds.delete(runId);
	state.terminalEventCleanupExpiredRunIds.add(runId);
	while (state.terminalEventCleanupExpiredRunIds.size > CLOSED_RUN_IDS_MAX) {
		const oldest = state.terminalEventCleanupExpiredRunIds.values().next().value;
		if (oldest === void 0) break;
		state.terminalEventCleanupExpiredRunIds.delete(oldest);
	}
}
function isTerminalEventCleanupExpired(runId) {
	return getPluginHostRuntimeState().terminalEventCleanupExpiredRunIds.has(runId);
}
function trackAgentEventHandler(runId, pending) {
	const state = getPluginHostRuntimeState();
	const handlers = state.pendingAgentEventHandlersByRunId.get(runId) ?? /* @__PURE__ */ new Set();
	handlers.add(pending);
	state.pendingAgentEventHandlersByRunId.set(runId, handlers);
	pending.finally(() => {
		handlers.delete(pending);
		if (handlers.size === 0 && getPluginHostRuntimeState().pendingAgentEventHandlersByRunId.get(runId) === handlers) state.pendingAgentEventHandlersByRunId.delete(runId);
	});
}
async function waitForLiveTerminalEventHandlers(runId) {
	for (;;) {
		const pendingHandlers = getPluginHostRuntimeState().pendingAgentEventHandlersByRunId.get(runId);
		if (!pendingHandlers || pendingHandlers.size === 0) return "settled";
		await Promise.allSettled(pendingHandlers);
	}
}
function waitForTerminalEventHandlers(params) {
	const { runId } = params;
	let timeout;
	const settled = waitForLiveTerminalEventHandlers(runId);
	const timedOut = new Promise((resolve) => {
		timeout = setTimeout(() => {
			markTerminalEventCleanupExpired(runId);
			getPluginHostRuntimeState().pendingAgentEventHandlersByRunId.delete(runId);
			log$1.warn(`plugin terminal agent event subscriptions still running after ${PLUGIN_TERMINAL_EVENT_CLEANUP_WAIT_MS}ms; clearing run context without waiting for them to settle`);
			resolve("timeout");
		}, PLUGIN_TERMINAL_EVENT_CLEANUP_WAIT_MS);
	});
	if (timeout) timeout.unref?.();
	return Promise.race([settled, timedOut]).then(() => {
		if (timeout) {
			clearTimeout(timeout);
			timeout = void 0;
		}
	});
}
function getPluginRunContextNamespaces(params) {
	const state = getPluginHostRuntimeState();
	let byPlugin = state.runContextByRunId.get(params.runId);
	if (!byPlugin && params.create) {
		byPlugin = /* @__PURE__ */ new Map();
		state.runContextByRunId.set(params.runId, byPlugin);
	}
	if (!byPlugin) return;
	let namespaces = byPlugin.get(params.pluginId);
	if (!namespaces && params.create) {
		namespaces = /* @__PURE__ */ new Map();
		byPlugin.set(params.pluginId, namespaces);
	}
	return namespaces;
}
function setPluginRunContext(params) {
	const runId = normalizeOptionalString(params.patch.runId);
	const namespace = normalizeNamespace(params.patch.namespace);
	if (!runId || !namespace) return false;
	if (!params.allowClosedRun && isPluginRunClosed(runId)) return false;
	if (params.patch.unset === true) {
		clearPluginRunContext({
			pluginId: params.pluginId,
			runId,
			namespace
		});
		return true;
	}
	if (params.patch.value === void 0) return false;
	if (!isPluginJsonValue(params.patch.value)) return false;
	getPluginRunContextNamespaces({
		runId,
		pluginId: params.pluginId,
		create: true
	})?.set(namespace, copyJsonValue(params.patch.value));
	return true;
}
function getPluginRunContext(params) {
	const runId = normalizeOptionalString(params.get.runId);
	const namespace = normalizeNamespace(params.get.namespace);
	if (!runId || !namespace) return;
	const value = getPluginRunContextNamespaces({
		runId,
		pluginId: params.pluginId
	})?.get(namespace);
	return value === void 0 ? void 0 : copyJsonValue(value);
}
function clearPluginRunContext(params) {
	const normalizedNamespace = params.namespace !== void 0 ? normalizeNamespace(params.namespace) : void 0;
	const namespaceFilter = normalizedNamespace !== void 0 && normalizedNamespace !== "" ? normalizedNamespace : void 0;
	const state = getPluginHostRuntimeState();
	const runIds = params.runId ? [params.runId] : [...state.runContextByRunId.keys()];
	for (const runId of runIds) {
		const byPlugin = state.runContextByRunId.get(runId);
		if (!byPlugin) continue;
		const pluginIds = params.pluginId ? [params.pluginId] : [...byPlugin.keys()];
		for (const pluginId of pluginIds) {
			const namespaces = byPlugin.get(pluginId);
			if (!namespaces) continue;
			if (namespaceFilter !== void 0) namespaces.delete(namespaceFilter);
			else namespaces.clear();
			if (namespaces.size === 0) byPlugin.delete(pluginId);
		}
		if (byPlugin.size === 0) state.runContextByRunId.delete(runId);
	}
	if (params.runId && !params.pluginId && namespaceFilter === void 0) state.pendingAgentEventHandlersByRunId.delete(params.runId);
}
function isTerminalAgentRunEvent(event) {
	const phase = event.data?.phase;
	return event.stream === "lifecycle" && (phase === "end" || phase === "error");
}
function logAgentEventSubscriptionFailure(params) {
	log$1.warn(`plugin agent event subscription failed: plugin=${params.pluginId} subscription=${params.subscriptionId} error=${String(params.error)}`);
}
function dispatchPluginAgentEventSubscriptions(params) {
	const subscriptions = params.registry?.agentEventSubscriptions ?? [];
	const pendingHandlers = [];
	const isTerminalEvent = isTerminalAgentRunEvent(params.event);
	for (const registration of subscriptions) {
		const streams = registration.subscription.streams;
		if (streams && streams.length > 0 && !streams.includes(params.event.stream)) continue;
		const pluginId = registration.pluginId;
		const runId = params.event.runId;
		let handlerActive = true;
		const ctx = {
			getRunContext: (namespace) => getPluginRunContext({
				pluginId,
				get: {
					runId,
					namespace
				}
			}),
			setRunContext: (namespace, value) => {
				setPluginRunContext({
					pluginId,
					patch: {
						runId,
						namespace,
						value
					},
					allowClosedRun: isTerminalEvent && handlerActive && !isTerminalEventCleanupExpired(runId)
				});
			},
			clearRunContext: (namespace) => {
				clearPluginRunContext({
					pluginId,
					runId,
					namespace
				});
			}
		};
		try {
			const pending = Promise.resolve(registration.subscription.handle(structuredClone(params.event), ctx)).catch((error) => {
				logAgentEventSubscriptionFailure({
					pluginId,
					subscriptionId: registration.subscription.id,
					error
				});
			}).finally(() => {
				handlerActive = false;
			});
			trackAgentEventHandler(runId, pending);
			pendingHandlers.push(pending);
		} catch (error) {
			handlerActive = false;
			logAgentEventSubscriptionFailure({
				pluginId,
				subscriptionId: registration.subscription.id,
				error
			});
		}
	}
	if (isTerminalEvent) {
		markPluginRunClosed(params.event.runId);
		waitForTerminalEventHandlers({ runId: params.event.runId }).then(() => {
			clearPluginRunContext({ runId: params.event.runId });
		});
	}
}
function registerPluginSessionSchedulerJob(params) {
	const id = normalizeOptionalString(params.job.id);
	const sessionKey = normalizeOptionalString(params.job.sessionKey);
	const kind = normalizeOptionalString(params.job.kind);
	if (!id || !sessionKey || !kind) return;
	const state = getPluginHostRuntimeState();
	const jobs = state.schedulerJobsByPlugin.get(params.pluginId) ?? /* @__PURE__ */ new Map();
	const generation = state.nextSchedulerJobGeneration++;
	jobs.set(id, {
		pluginId: params.pluginId,
		pluginName: params.pluginName,
		job: {
			...params.job,
			id,
			sessionKey,
			kind
		},
		generation,
		...params.ownerRegistry ? { ownerRegistry: params.ownerRegistry } : {}
	});
	state.schedulerJobsByPlugin.set(params.pluginId, jobs);
	return {
		id,
		pluginId: params.pluginId,
		sessionKey,
		kind
	};
}
function deletePluginSessionSchedulerJob(params) {
	const state = getPluginHostRuntimeState();
	const jobs = state.schedulerJobsByPlugin.get(params.pluginId);
	const record = jobs?.get(params.jobId);
	if (!jobs || !record) return;
	if (params.sessionKey && record.job.sessionKey !== params.sessionKey) return;
	if (params.expectedGeneration !== void 0 && record.generation !== params.expectedGeneration) return;
	jobs.delete(params.jobId);
	if (jobs.size === 0) state.schedulerJobsByPlugin.delete(params.pluginId);
}
function hasPluginSessionSchedulerJob(params) {
	const record = getPluginHostRuntimeState().schedulerJobsByPlugin.get(params.pluginId)?.get(params.jobId);
	if (!record) return false;
	if (params.sessionKey && record.job.sessionKey !== params.sessionKey) return false;
	return params.generation === void 0 || record.generation === params.generation;
}
function getPluginSessionSchedulerJobGeneration(params) {
	const record = getPluginHostRuntimeState().schedulerJobsByPlugin.get(params.pluginId)?.get(params.jobId);
	if (!record) return;
	if (params.sessionKey && record.job.sessionKey !== params.sessionKey) return;
	return record.generation;
}
function makePluginSessionSchedulerJobKey(pluginId, jobId) {
	return JSON.stringify([pluginId, jobId]);
}
async function cleanupPluginSessionSchedulerJobs(params) {
	const state = getPluginHostRuntimeState();
	const failures = [];
	const shouldCleanup = params.shouldCleanup ?? (() => true);
	if (!shouldCleanup()) return failures;
	const registryRecordKeys = /* @__PURE__ */ new Set();
	const schedulerJobKey = (pluginId, jobId, sessionKey) => `${pluginId}\0${jobId}\0${sessionKey}`;
	if (params.records) for (const record of params.records) {
		if (!shouldCleanup()) return failures;
		if (params.pluginId && record.pluginId !== params.pluginId) continue;
		const jobId = normalizeOptionalString(record.job.id);
		const sessionKey = normalizeOptionalString(record.job.sessionKey);
		if (!jobId || !sessionKey) continue;
		if (params.sessionKey && sessionKey !== params.sessionKey) continue;
		registryRecordKeys.add(schedulerJobKey(record.pluginId, jobId, sessionKey));
		const liveGeneration = getPluginSessionSchedulerJobGeneration({
			pluginId: record.pluginId,
			jobId,
			sessionKey
		});
		if (record.generation !== void 0 && liveGeneration === void 0) continue;
		if (record.generation === void 0 && !hasPluginSessionSchedulerJob({
			pluginId: record.pluginId,
			jobId,
			sessionKey
		})) continue;
		if (params.preserveJobIds?.has(jobId) ?? false) continue;
		const hookId = `scheduler:${jobId}`;
		try {
			await withPluginHostCleanupTimeout(hookId, () => record.job.cleanup?.({
				reason: params.reason,
				sessionKey,
				jobId
			}));
		} catch (error) {
			failures.push({
				pluginId: record.pluginId,
				hookId,
				error
			});
			continue;
		}
		if (!shouldCleanup()) continue;
		deletePluginSessionSchedulerJob({
			pluginId: record.pluginId,
			jobId,
			sessionKey,
			expectedGeneration: record.generation
		});
	}
	const pluginIds = params.pluginId ? [params.pluginId] : [...state.schedulerJobsByPlugin.keys()];
	for (const pluginId of pluginIds) {
		if (!shouldCleanup()) return failures;
		const jobs = state.schedulerJobsByPlugin.get(pluginId);
		if (!jobs) continue;
		for (const [jobId, record] of jobs.entries()) {
			if (!shouldCleanup()) return failures;
			if (params.sessionKey && record.job.sessionKey !== params.sessionKey) continue;
			if (registryRecordKeys.has(schedulerJobKey(pluginId, jobId, record.job.sessionKey))) continue;
			if (params.preserveOwnerRegistry !== void 0 && record.ownerRegistry === params.preserveOwnerRegistry) continue;
			if (params.excludeJobKeys?.has(makePluginSessionSchedulerJobKey(pluginId, jobId))) continue;
			if (params.preserveJobIds?.has(jobId)) continue;
			const hookId = `scheduler:${jobId}`;
			try {
				await withPluginHostCleanupTimeout(hookId, () => record.job.cleanup?.({
					reason: params.reason,
					sessionKey: record.job.sessionKey,
					jobId
				}));
			} catch (error) {
				failures.push({
					pluginId,
					hookId,
					error
				});
				continue;
			}
			if (!shouldCleanup()) continue;
			jobs.delete(jobId);
		}
		if (jobs.size === 0) state.schedulerJobsByPlugin.delete(pluginId);
	}
	return failures;
}
function clearPluginHostRuntimeState(params) {
	clearPluginRunContext(params ?? {});
	if (params?.pluginId) getPluginHostRuntimeState().schedulerJobsByPlugin.delete(params.pluginId);
	else if (!params?.runId) {
		const state = getPluginHostRuntimeState();
		state.schedulerJobsByPlugin.clear();
		state.pendingAgentEventHandlersByRunId.clear();
		state.closedRunIds.clear();
		state.terminalEventCleanupExpiredRunIds.clear();
	}
}
//#endregion
//#region src/plugins/registry-lifecycle.ts
const retiredRegistries = /* @__PURE__ */ new WeakSet();
const activatedRegistries = /* @__PURE__ */ new WeakSet();
function markPluginRegistryRetired(registry) {
	if (registry) retiredRegistries.add(registry);
}
function markPluginRegistryActive(registry) {
	if (registry) {
		activatedRegistries.add(registry);
		retiredRegistries.delete(registry);
	}
}
function isPluginRegistryActivated(registry) {
	return activatedRegistries.has(registry);
}
function isPluginRegistryRetired(registry) {
	return retiredRegistries.has(registry);
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
			agentEventBridgeUnsubscribe: void 0,
			key: null,
			workspaceDir: null,
			runtimeSubagentMode: "default",
			importedPluginIds: /* @__PURE__ */ new Set()
		};
		globalState[PLUGIN_REGISTRY_STATE] = registryState;
	}
	return registryState;
})();
function registryHasPluginHostCleanupWork(registry) {
	if (!registry) return false;
	return registry.plugins.some((plugin) => plugin.status === "loaded") || (registry.sessionExtensions?.length ?? 0) > 0 || (registry.runtimeLifecycles?.length ?? 0) > 0 || (registry.agentEventSubscriptions?.length ?? 0) > 0 || (registry.sessionSchedulerJobs?.length ?? 0) > 0;
}
function isRegistryPinned(registry) {
	return state.httpRoute.pinned && state.httpRoute.registry === registry || state.channel.pinned && state.channel.registry === registry;
}
function isRegistryLive(registry) {
	return state.activeRegistry === registry || isRegistryPinned(registry);
}
async function cleanupPreviousPluginHostRegistry(params) {
	const [{ getRuntimeConfig }, { cleanupReplacedPluginHostRegistry }] = await Promise.all([import("./config/config.js"), import("./host-hook-cleanup-BNlJQu7G.js")]);
	const nextRegistry = asPluginRegistry(state.activeRegistry);
	if (!nextRegistry || nextRegistry === params.previousRegistry) return;
	const shouldCleanup = () => state.activeRegistry !== params.previousRegistry;
	await cleanupReplacedPluginHostRegistry({
		cfg: getRuntimeConfig(),
		previousRegistry: params.previousRegistry,
		nextRegistry,
		shouldCleanup
	});
}
function cleanupRetiredPluginHostRegistry(previousRegistry) {
	if (!registryHasPluginHostCleanupWork(previousRegistry)) return;
	cleanupPreviousPluginHostRegistry({ previousRegistry }).catch((error) => {
		log.warn(`plugin host registry cleanup failed: ${String(error)}`);
	});
}
function retirePluginRegistryIfUnused(registry) {
	if (!registry || isRegistryLive(registry)) return false;
	markPluginRegistryRetired(registry);
	return true;
}
function collectLivePluginAgentEventRegistries() {
	const registries = [];
	const seen = /* @__PURE__ */ new Set();
	const addRegistry = (registry) => {
		if (!registry || seen.has(registry)) return;
		seen.add(registry);
		registries.push(registry);
	};
	addRegistry(asPluginRegistry(state.activeRegistry));
	addRegistry(asPluginRegistry(state.httpRoute.registry));
	addRegistry(asPluginRegistry(state.channel.registry));
	return registries;
}
function syncPluginAgentEventBridge() {
	state.agentEventBridgeUnsubscribe?.();
	state.agentEventBridgeUnsubscribe = void 0;
	if (collectLivePluginAgentEventRegistries().length === 0) return;
	state.agentEventBridgeUnsubscribe = onAgentEvent((event) => {
		for (const registry of collectLivePluginAgentEventRegistries()) dispatchPluginAgentEventSubscriptions({
			registry,
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
	markPluginRegistryActive(registry);
	state.activeVersion += 1;
	syncTrackedSurface(state.httpRoute, registry, true);
	syncTrackedSurface(state.channel, registry, true);
	state.key = cacheKey ?? null;
	state.workspaceDir = workspaceDir ?? null;
	state.runtimeSubagentMode = runtimeSubagentMode;
	syncPluginAgentEventBridge();
	if (!previousRegistry || previousRegistry === registry) return;
	if (!retirePluginRegistryIfUnused(previousRegistry)) return;
	cleanupRetiredPluginHostRegistry(previousRegistry);
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
		markPluginRegistryActive(state.activeRegistry);
		state.activeVersion += 1;
		syncTrackedSurface(state.httpRoute, state.activeRegistry);
		syncTrackedSurface(state.channel, state.activeRegistry);
	}
	return asPluginRegistry(state.activeRegistry);
}
function pinActivePluginHttpRouteRegistry(registry) {
	const previousRegistry = asPluginRegistry(state.httpRoute.registry);
	installSurfaceRegistry(state.httpRoute, registry, true);
	markPluginRegistryActive(registry);
	syncPluginAgentEventBridge();
	if (retirePluginRegistryIfUnused(previousRegistry)) cleanupRetiredPluginHostRegistry(previousRegistry);
}
function releasePinnedPluginHttpRouteRegistry(registry) {
	if (registry && state.httpRoute.registry !== registry) return;
	const previousRegistry = asPluginRegistry(state.httpRoute.registry);
	installSurfaceRegistry(state.httpRoute, state.activeRegistry, false);
	syncPluginAgentEventBridge();
	if (retirePluginRegistryIfUnused(previousRegistry)) cleanupRetiredPluginHostRegistry(previousRegistry);
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
function pinActivePluginChannelRegistry(registry) {
	const previousRegistry = asPluginRegistry(state.channel.registry);
	installSurfaceRegistry(state.channel, registry, true);
	markPluginRegistryActive(registry);
	syncPluginAgentEventBridge();
	if (retirePluginRegistryIfUnused(previousRegistry)) cleanupRetiredPluginHostRegistry(previousRegistry);
}
function releasePinnedPluginChannelRegistry(registry) {
	if (registry && state.channel.registry !== registry) return;
	const previousRegistry = asPluginRegistry(state.channel.registry);
	installSurfaceRegistry(state.channel, state.activeRegistry, false);
	syncPluginAgentEventBridge();
	if (retirePluginRegistryIfUnused(previousRegistry)) cleanupRetiredPluginHostRegistry(previousRegistry);
}
function getActivePluginChannelRegistry() {
	return getActivePluginChannelRegistrySnapshotFromState().registry;
}
function getActivePluginChannelRegistryVersion() {
	return getActivePluginChannelRegistrySnapshotFromState().version;
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
	syncPluginAgentEventBridge();
	clearPluginHostRuntimeState();
}
//#endregion
export { registerPluginSessionSchedulerJob as A, isPluginRegistryRetired as C, getPluginRunContext as D, deletePluginSessionSchedulerJob as E, createEmptyPluginRegistry as F, withPluginHostCleanupTimeout as M, buildPluginAgentTurnPrepareContext as N, getPluginSessionSchedulerJobGeneration as O, normalizePluginHostHookId as P, isPluginRegistryActivated as S, clearPluginRunContext as T, requireActivePluginHttpRouteRegistry as _, getActivePluginRegistry as a, resolveActivePluginHttpRouteRegistry as b, getActivePluginRegistryWorkspaceDir as c, pinActivePluginChannelRegistry as d, pinActivePluginHttpRouteRegistry as f, requireActivePluginChannelRegistry as g, releasePinnedPluginHttpRouteRegistry as h, getActivePluginHttpRouteRegistryVersion as i, setPluginRunContext as j, makePluginSessionSchedulerJobKey as k, getActivePluginRuntimeSubagentMode as l, releasePinnedPluginChannelRegistry as m, getActivePluginChannelRegistryVersion as n, getActivePluginRegistryKey as o, recordImportedPluginId as p, getActivePluginHttpRouteRegistry as r, getActivePluginRegistryVersion as s, getActivePluginChannelRegistry as t, listImportedRuntimePluginIds as u, requireActivePluginRegistry as v, cleanupPluginSessionSchedulerJobs as w, setActivePluginRegistry as x, resetPluginRuntimeStateForTest as y };

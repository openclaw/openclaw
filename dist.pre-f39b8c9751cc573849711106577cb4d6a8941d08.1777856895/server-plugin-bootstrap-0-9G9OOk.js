import { n as resolveGlobalSingleton } from "./global-singleton-COlWgaGc.js";
import { c as isRecord } from "./utils-CCskKJVV.js";
import { o as normalizePluginsConfig } from "./config-state-6n1ivR82.js";
import { n as GATEWAY_CLIENT_IDS, r as GATEWAY_CLIENT_MODES } from "./client-info-BcGK4jUE.js";
import "./protocol-Bj4aFpjA.js";
import { t as ADMIN_SCOPE } from "./operator-scopes-CGmIJmv-.js";
import "./method-scopes-rlD7_7jW.js";
import { t as applyPluginAutoEnable } from "./plugin-auto-enable-WDuMzUkg.js";
import { l as loadOpenClawPlugins, r as clearActivatedPluginRuntimeState } from "./loader-BPHnZ58g.js";
import { S as createEmptyPluginRegistry, d as pinActivePluginChannelRegistry, x as setActivePluginRegistry } from "./runtime-BB5JwDDz.js";
import { t as getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope-9a7R9drR.js";
import { r as createPluginRuntimeLoaderLogger } from "./load-context-CklrErb6.js";
import { C as parseModelRef, S as normalizeModelRef } from "./model-selection-shared-HUsqLCFt.js";
import "./model-selection-DqTgZ6sy.js";
import { t as primeConfiguredBindingRegistry } from "./binding-registry-4-JwCwug.js";
import { i as setGatewaySubagentRuntime, r as setGatewayNodesRuntime } from "./gateway-bindings-T0r_t3TM.js";
import { t as loadPluginLookUpTable } from "./plugin-lookup-table-6BmmFKvC.js";
import { randomUUID } from "node:crypto";
//#region src/gateway/plugin-activation-runtime-config.ts
function hasOwnValue(record, key) {
	return Object.prototype.hasOwnProperty.call(record, key);
}
function mergeChannelActivationSections(params) {
	const activationChannels = params.activationConfig.channels;
	if (!isRecord(activationChannels)) return params.runtimeConfig;
	const runtimeChannels = isRecord(params.runtimeConfig.channels) ? params.runtimeConfig.channels : {};
	let nextChannels;
	for (const [channelId, activationChannel] of Object.entries(activationChannels)) {
		if (!isRecord(activationChannel) || !hasOwnValue(activationChannel, "enabled")) continue;
		const runtimeChannel = runtimeChannels[channelId];
		const runtimeChannelRecord = isRecord(runtimeChannel) ? runtimeChannel : {};
		nextChannels ??= { ...runtimeChannels };
		nextChannels[channelId] = {
			...runtimeChannelRecord,
			enabled: activationChannel.enabled
		};
	}
	if (nextChannels === void 0) return params.runtimeConfig;
	return {
		...params.runtimeConfig,
		channels: nextChannels
	};
}
function mergePluginActivationSections(params) {
	const activationPlugins = params.activationConfig.plugins;
	if (!isRecord(activationPlugins)) return params.runtimeConfig;
	const runtimePlugins = isRecord(params.runtimeConfig.plugins) ? params.runtimeConfig.plugins : {};
	let nextPlugins;
	if (Array.isArray(activationPlugins.allow)) nextPlugins = {
		...runtimePlugins,
		allow: [...activationPlugins.allow]
	};
	const activationEntries = activationPlugins.entries;
	if (isRecord(activationEntries)) {
		const runtimeEntries = isRecord(runtimePlugins.entries) ? runtimePlugins.entries : {};
		let nextEntries;
		for (const [pluginId, activationEntry] of Object.entries(activationEntries)) {
			if (!isRecord(activationEntry) || !hasOwnValue(activationEntry, "enabled")) continue;
			const runtimeEntry = runtimeEntries[pluginId];
			const runtimeEntryRecord = isRecord(runtimeEntry) ? runtimeEntry : {};
			nextEntries ??= { ...runtimeEntries };
			nextEntries[pluginId] = {
				...runtimeEntryRecord,
				enabled: activationEntry.enabled
			};
		}
		if (nextEntries !== void 0) nextPlugins = {
			...runtimePlugins,
			...nextPlugins,
			entries: nextEntries
		};
	}
	if (nextPlugins === void 0) return params.runtimeConfig;
	return {
		...params.runtimeConfig,
		plugins: nextPlugins
	};
}
function mergeActivationSectionsIntoRuntimeConfig(params) {
	return mergePluginActivationSections({
		...params,
		runtimeConfig: mergeChannelActivationSections(params)
	});
}
//#endregion
//#region src/gateway/server-plugins.ts
const FALLBACK_GATEWAY_CONTEXT_STATE_KEY = Symbol.for("openclaw.fallbackGatewayContextState");
const getFallbackGatewayContextState = () => resolveGlobalSingleton(FALLBACK_GATEWAY_CONTEXT_STATE_KEY, () => ({
	context: void 0,
	resolveContext: void 0
}));
function setFallbackGatewayContextResolver(resolveContext) {
	const fallbackGatewayContextState = getFallbackGatewayContextState();
	fallbackGatewayContextState.context = void 0;
	fallbackGatewayContextState.resolveContext = resolveContext;
	return () => {
		const currentFallbackGatewayContextState = getFallbackGatewayContextState();
		if (currentFallbackGatewayContextState.resolveContext === resolveContext) {
			currentFallbackGatewayContextState.context = void 0;
			currentFallbackGatewayContextState.resolveContext = void 0;
		}
	};
}
function getFallbackGatewayContext() {
	const fallbackGatewayContextState = getFallbackGatewayContextState();
	return fallbackGatewayContextState.resolveContext?.() ?? fallbackGatewayContextState.context;
}
const PLUGIN_SUBAGENT_POLICY_STATE_KEY = Symbol.for("openclaw.pluginSubagentOverridePolicyState");
const getPluginSubagentPolicyState = () => resolveGlobalSingleton(PLUGIN_SUBAGENT_POLICY_STATE_KEY, () => ({ policies: {} }));
function normalizeAllowedModelRef(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (trimmed === "*") return "*";
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash >= trimmed.length - 1) return null;
	const providerRaw = trimmed.slice(0, slash).trim();
	const modelRaw = trimmed.slice(slash + 1).trim();
	if (!providerRaw || !modelRaw) return null;
	const normalized = normalizeModelRef(providerRaw, modelRaw);
	return `${normalized.provider}/${normalized.model}`;
}
function setPluginSubagentOverridePolicies(cfg) {
	const pluginSubagentPolicyState = getPluginSubagentPolicyState();
	const normalized = normalizePluginsConfig(cfg.plugins);
	const policies = {};
	for (const [pluginId, entry] of Object.entries(normalized.entries)) {
		const allowModelOverride = entry.subagent?.allowModelOverride === true;
		const hasConfiguredAllowlist = entry.subagent?.hasAllowedModelsConfig === true;
		const configuredAllowedModels = entry.subagent?.allowedModels ?? [];
		const allowedModels = /* @__PURE__ */ new Set();
		let allowAnyModel = false;
		for (const modelRef of configuredAllowedModels) {
			const normalizedModelRef = normalizeAllowedModelRef(modelRef);
			if (!normalizedModelRef) continue;
			if (normalizedModelRef === "*") {
				allowAnyModel = true;
				continue;
			}
			allowedModels.add(normalizedModelRef);
		}
		if (!allowModelOverride && !hasConfiguredAllowlist && allowedModels.size === 0 && !allowAnyModel) continue;
		policies[pluginId] = {
			allowModelOverride,
			allowAnyModel,
			hasConfiguredAllowlist,
			allowedModels
		};
	}
	pluginSubagentPolicyState.policies = policies;
}
function authorizeFallbackModelOverride(params) {
	const pluginSubagentPolicyState = getPluginSubagentPolicyState();
	const pluginId = params.pluginId?.trim();
	if (!pluginId) return {
		allowed: false,
		reason: "provider/model override requires plugin identity in fallback subagent runs."
	};
	const policy = pluginSubagentPolicyState.policies[pluginId];
	if (!policy?.allowModelOverride) return {
		allowed: false,
		reason: `plugin "${pluginId}" is not trusted for fallback provider/model override requests. See https://docs.openclaw.ai/tools/plugin#runtime-helpers and search for: plugins.entries.<id>.subagent.allowModelOverride`
	};
	if (policy.allowAnyModel) return { allowed: true };
	if (policy.hasConfiguredAllowlist && policy.allowedModels.size === 0) return {
		allowed: false,
		reason: `plugin "${pluginId}" configured subagent.allowedModels, but none of the entries normalized to a valid provider/model target.`
	};
	if (policy.allowedModels.size === 0) return { allowed: true };
	const requestedModelRef = resolveRequestedFallbackModelRef(params);
	if (!requestedModelRef) return {
		allowed: false,
		reason: "fallback provider/model overrides that use an allowlist must resolve to a canonical provider/model target."
	};
	if (policy.allowedModels.has(requestedModelRef)) return { allowed: true };
	return {
		allowed: false,
		reason: `model override "${requestedModelRef}" is not allowlisted for plugin "${pluginId}".`
	};
}
function resolveRequestedFallbackModelRef(params) {
	if (params.provider && params.model) {
		const normalizedRequest = normalizeModelRef(params.provider, params.model);
		return `${normalizedRequest.provider}/${normalizedRequest.model}`;
	}
	const rawModel = params.model?.trim();
	if (!rawModel || !rawModel.includes("/")) return null;
	const parsed = parseModelRef(rawModel, "");
	if (!parsed?.provider || !parsed.model) return null;
	return `${parsed.provider}/${parsed.model}`;
}
function createSyntheticOperatorClient(params) {
	const pluginRuntimeOwnerId = typeof params?.pluginRuntimeOwnerId === "string" && params.pluginRuntimeOwnerId.trim() ? params.pluginRuntimeOwnerId.trim() : void 0;
	return {
		connect: {
			minProtocol: 3,
			maxProtocol: 3,
			client: {
				id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
				version: "internal",
				platform: "node",
				mode: GATEWAY_CLIENT_MODES.BACKEND
			},
			role: "operator",
			scopes: params?.scopes ?? ["operator.write"]
		},
		internal: {
			allowModelOverride: params?.allowModelOverride === true,
			...pluginRuntimeOwnerId ? { pluginRuntimeOwnerId } : {}
		}
	};
}
function hasAdminScope(client) {
	return (Array.isArray(client?.connect?.scopes) ? client.connect.scopes : []).includes(ADMIN_SCOPE);
}
function canClientUseModelOverride(client) {
	return hasAdminScope(client) || client?.internal?.allowModelOverride === true;
}
function mergeGatewayClientInternal(client, internal) {
	if (!client || !internal) return client ?? null;
	return {
		...client,
		internal: {
			...client.internal,
			...internal
		}
	};
}
async function dispatchGatewayMethod(method, params, options) {
	const scope = getPluginRuntimeGatewayRequestScope();
	const context = scope?.context ?? getFallbackGatewayContext();
	const isWebchatConnect = scope?.isWebchatConnect ?? (() => false);
	if (!context) throw new Error(`Plugin subagent dispatch requires a gateway request scope (method: ${method}). No scope set and no fallback context available.`);
	let result;
	const { handleGatewayRequest } = await import("./server-methods-D9nE2CIK.js");
	const pluginRuntimeOwnerId = typeof options?.pluginRuntimeOwnerId === "string" && options.pluginRuntimeOwnerId.trim() ? options.pluginRuntimeOwnerId.trim() : void 0;
	const syntheticClient = createSyntheticOperatorClient({
		allowModelOverride: options?.allowSyntheticModelOverride === true,
		...pluginRuntimeOwnerId ? { pluginRuntimeOwnerId } : {},
		scopes: options?.syntheticScopes
	});
	const scopedClient = mergeGatewayClientInternal(scope?.client, pluginRuntimeOwnerId ? { pluginRuntimeOwnerId } : void 0);
	await handleGatewayRequest({
		req: {
			type: "req",
			id: `plugin-subagent-${randomUUID()}`,
			method,
			params
		},
		client: options?.forceSyntheticClient === true ? syntheticClient : scopedClient ?? syntheticClient,
		isWebchatConnect,
		respond: (ok, payload, error) => {
			if (!result) result = {
				ok,
				payload,
				error
			};
		},
		context
	});
	if (!result) throw new Error(`Gateway method "${method}" completed without a response.`);
	if (!result.ok) throw new Error(result.error?.message ?? `Gateway method "${method}" failed.`);
	return result.payload;
}
function createGatewaySubagentRuntime() {
	const getSessionMessages = async (params) => {
		const payload = await dispatchGatewayMethod("sessions.get", {
			key: params.sessionKey,
			...params.limit != null && { limit: params.limit }
		});
		return { messages: Array.isArray(payload?.messages) ? payload.messages : [] };
	};
	return {
		async run(params) {
			const scope = getPluginRuntimeGatewayRequestScope();
			const pluginId = typeof scope?.pluginId === "string" && scope.pluginId.trim() ? scope.pluginId.trim() : void 0;
			const overrideRequested = Boolean(params.provider || params.model);
			const hasRequestScopeClient = Boolean(scope?.client);
			let allowOverride = hasRequestScopeClient && canClientUseModelOverride(scope?.client ?? null);
			let allowSyntheticModelOverride = false;
			if (overrideRequested && !allowOverride && !hasRequestScopeClient) {
				const fallbackAuth = authorizeFallbackModelOverride({
					pluginId: scope?.pluginId,
					provider: params.provider,
					model: params.model
				});
				if (!fallbackAuth.allowed) throw new Error(fallbackAuth.reason);
				allowOverride = true;
				allowSyntheticModelOverride = true;
			}
			if (overrideRequested && !allowOverride) throw new Error("provider/model override is not authorized for this plugin subagent run.");
			const runId = (await dispatchGatewayMethod("agent", {
				sessionKey: params.sessionKey,
				message: params.message,
				deliver: params.deliver ?? false,
				...allowOverride && params.provider && { provider: params.provider },
				...allowOverride && params.model && { model: params.model },
				...params.extraSystemPrompt && { extraSystemPrompt: params.extraSystemPrompt },
				...params.lane && { lane: params.lane },
				...params.lightContext === true && { bootstrapContextMode: "lightweight" },
				idempotencyKey: params.idempotencyKey || randomUUID()
			}, {
				allowSyntheticModelOverride,
				...pluginId ? { pluginRuntimeOwnerId: pluginId } : {}
			}))?.runId;
			if (typeof runId !== "string" || !runId) throw new Error("Gateway agent method returned an invalid runId.");
			return { runId };
		},
		async waitForRun(params) {
			const payload = await dispatchGatewayMethod("agent.wait", {
				runId: params.runId,
				...params.timeoutMs != null && { timeoutMs: params.timeoutMs }
			});
			const status = payload?.status;
			if (status !== "ok" && status !== "error" && status !== "timeout") throw new Error(`Gateway agent.wait returned unexpected status: ${status}`);
			return {
				status,
				...typeof payload?.error === "string" && payload.error && { error: payload.error }
			};
		},
		getSessionMessages,
		async getSession(params) {
			return getSessionMessages(params);
		},
		async deleteSession(params) {
			const scope = getPluginRuntimeGatewayRequestScope();
			const pluginId = typeof scope?.pluginId === "string" && scope.pluginId.trim() ? scope.pluginId.trim() : void 0;
			const pluginOwnedCleanupOptions = pluginId ? {
				pluginRuntimeOwnerId: pluginId,
				...!hasAdminScope(scope?.client) ? {
					forceSyntheticClient: true,
					syntheticScopes: [ADMIN_SCOPE]
				} : {}
			} : void 0;
			await dispatchGatewayMethod("sessions.delete", {
				key: params.sessionKey,
				deleteTranscript: params.deleteTranscript ?? true
			}, pluginOwnedCleanupOptions);
		}
	};
}
function createGatewayNodesRuntime() {
	return {
		async list(params) {
			const payload = await dispatchGatewayMethod("node.list", {});
			const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
			return { nodes: params?.connected === true ? nodes.filter((node) => node !== null && typeof node === "object" && node.connected === true) : nodes };
		},
		async invoke(params) {
			return await dispatchGatewayMethod("node.invoke", {
				nodeId: params.nodeId,
				command: params.command,
				...params.params !== void 0 && { params: params.params },
				timeoutMs: params.timeoutMs,
				idempotencyKey: params.idempotencyKey || randomUUID()
			});
		}
	};
}
function createGatewayPluginRegistrationLogger(params) {
	const logger = createPluginRuntimeLoaderLogger();
	if (params?.suppressInfoLogs !== true) return logger;
	return {
		...logger,
		info: (_message) => void 0
	};
}
function loadGatewayPlugins(params) {
	const activationAutoEnabled = params.activationSourceConfig !== void 0 ? applyPluginAutoEnable({
		config: params.activationSourceConfig,
		env: process.env,
		...params.pluginLookUpTable?.manifestRegistry ? { manifestRegistry: params.pluginLookUpTable.manifestRegistry } : {}
	}) : void 0;
	const autoEnabled = params.activationSourceConfig !== void 0 ? {
		config: params.cfg,
		changes: activationAutoEnabled?.changes ?? [],
		autoEnabledReasons: params.autoEnabledReasons ?? activationAutoEnabled?.autoEnabledReasons ?? {}
	} : params.autoEnabledReasons !== void 0 ? {
		config: params.cfg,
		changes: [],
		autoEnabledReasons: params.autoEnabledReasons
	} : applyPluginAutoEnable({
		config: params.cfg,
		env: process.env,
		...params.pluginLookUpTable?.manifestRegistry ? { manifestRegistry: params.pluginLookUpTable.manifestRegistry } : {}
	});
	const resolvedConfig = autoEnabled.config;
	const pluginIds = params.pluginIds ?? [...(params.pluginLookUpTable ?? loadPluginLookUpTable({
		config: resolvedConfig,
		activationSourceConfig: params.activationSourceConfig,
		workspaceDir: params.workspaceDir,
		env: process.env
	})).startup.pluginIds];
	if (pluginIds.length === 0) {
		clearActivatedPluginRuntimeState();
		const pluginRegistry = createEmptyPluginRegistry();
		setActivePluginRegistry(pluginRegistry, void 0, "gateway-bindable", params.workspaceDir);
		return {
			pluginRegistry,
			gatewayMethods: [...params.baseMethods]
		};
	}
	const pluginRegistry = loadOpenClawPlugins({
		config: resolvedConfig,
		activationSourceConfig: params.activationSourceConfig ?? params.cfg,
		autoEnabledReasons: autoEnabled.autoEnabledReasons,
		workspaceDir: params.workspaceDir,
		onlyPluginIds: pluginIds,
		logger: createGatewayPluginRegistrationLogger({ suppressInfoLogs: params.suppressPluginInfoLogs }),
		...params.coreGatewayHandlers !== void 0 && { coreGatewayHandlers: params.coreGatewayHandlers },
		...params.coreGatewayMethodNames !== void 0 && { coreGatewayMethodNames: params.coreGatewayMethodNames },
		runtimeOptions: { allowGatewaySubagentBinding: true },
		preferSetupRuntimeForChannelPlugins: params.preferSetupRuntimeForChannelPlugins,
		preferBuiltPluginArtifacts: true,
		...params.pluginLookUpTable?.manifestRegistry ? { manifestRegistry: params.pluginLookUpTable.manifestRegistry } : {}
	});
	const pluginMethods = Object.keys(pluginRegistry.gatewayHandlers);
	return {
		pluginRegistry,
		gatewayMethods: Array.from(new Set([...params.baseMethods, ...pluginMethods]))
	};
}
//#endregion
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
		baseMethods: params.baseMethods,
		pluginIds: params.pluginIds,
		pluginLookUpTable: params.pluginLookUpTable,
		preferSetupRuntimeForChannelPlugins: params.preferSetupRuntimeForChannelPlugins,
		suppressPluginInfoLogs: params.suppressPluginInfoLogs
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
export { mergeActivationSectionsIntoRuntimeConfig as a, setFallbackGatewayContextResolver as i, prepareGatewayPluginLoad as n, reloadDeferredGatewayPlugins as r, loadGatewayStartupPlugins as t };

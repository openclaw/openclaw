import { n as resolveGlobalSingleton } from "./global-singleton-DE6St75u.js";
import { s as normalizePluginsConfig } from "./config-state-CjJBf8PG.js";
import { i as getPluginModuleLoaderStats } from "./plugin-module-loader-cache-D0U0PNnl.js";
import { n as GATEWAY_CLIENT_IDS, r as GATEWAY_CLIENT_MODES } from "./client-info-BVWE_ra1.js";
import { n as resolveSafeTimeoutDelayMs } from "./timer-delay-awNPCchy.js";
import "./version-DDqbebEG.js";
import { t as ADMIN_SCOPE } from "./operator-scopes-DGvgHuOd.js";
import "./method-scopes-D4RcH8qD.js";
import { t as applyPluginAutoEnable } from "./plugin-auto-enable-CuCUT4Z1.js";
import { c as loadOpenClawPlugins, n as clearActivatedPluginRuntimeState } from "./loader-DKK7Ita0.js";
import { F as createEmptyPluginRegistry, x as setActivePluginRegistry } from "./runtime-DHxRl5F1.js";
import { t as getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope-B9qYB9tg.js";
import { r as createPluginRuntimeLoaderLogger } from "./load-context-BO-9CJts.js";
import { i as parseModelRef, r as normalizeModelRef } from "./model-selection-normalize-CBfQo-Fd.js";
import "./model-selection-P-81eBKx.js";
import { t as loadPluginLookUpTable } from "./plugin-lookup-table-CWObPlB3.js";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
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
		reason: `plugin "${pluginId}" is not trusted for fallback provider/model override requests. See https://docs.openclaw.ai/plugins/sdk-runtime#api-runtime-subagent and search for: plugins.entries.<id>.subagent.allowModelOverride`
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
			minProtocol: 4,
			maxProtocol: 4,
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
			...params?.scopes?.includes("operator.approvals") ? { approvalRuntime: true } : {},
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
function unwrapGatewayMethodDispatchResponse(method, response) {
	if (!response.ok) throw new Error(response.error?.message ?? `Gateway method "${method}" failed.`);
	return response.payload;
}
async function dispatchGatewayMethodInProcessRaw(method, params, options) {
	const scope = getPluginRuntimeGatewayRequestScope();
	const context = scope?.context ?? getFallbackGatewayContext();
	const isWebchatConnect = scope?.isWebchatConnect ?? (() => false);
	if (!context) throw new Error(`In-process gateway dispatch requires a gateway request scope (method: ${method}). No scope set and no fallback context available.`);
	if (options?.requireScopedClient === true && !scope?.client) throw new Error(`In-process gateway dispatch requires an authenticated plugin request scope (method: ${method}).`);
	let firstResponse;
	let finalResponse;
	let resolveFinalResponse;
	const { handleGatewayRequest } = await import("./server-methods-90LGtoqF.js");
	const pluginRuntimeOwnerId = typeof options?.pluginRuntimeOwnerId === "string" && options.pluginRuntimeOwnerId.trim() ? options.pluginRuntimeOwnerId.trim() : void 0;
	const syntheticClient = createSyntheticOperatorClient({
		allowModelOverride: options?.allowSyntheticModelOverride === true,
		...pluginRuntimeOwnerId ? { pluginRuntimeOwnerId } : {},
		scopes: options?.syntheticScopes
	});
	const scopedClient = mergeGatewayClientInternal(scope?.client, pluginRuntimeOwnerId ? { pluginRuntimeOwnerId } : void 0);
	if (options?.disableSyntheticClient === true && !scopedClient) throw new Error(`In-process gateway dispatch requires a scoped client (method: ${method}).`);
	await handleGatewayRequest({
		req: {
			type: "req",
			id: `plugin-subagent-${randomUUID()}`,
			method,
			params
		},
		client: options?.forceSyntheticClient === true ? syntheticClient : scopedClient ?? (options?.disableSyntheticClient === true ? null : syntheticClient),
		isWebchatConnect,
		respond: (ok, payload, error, meta) => {
			const response = {
				ok,
				payload,
				error,
				...meta ? { meta } : {}
			};
			if (!firstResponse) {
				firstResponse = response;
				return;
			}
			if (!finalResponse) {
				finalResponse = response;
				resolveFinalResponse?.(response);
			}
		},
		context
	});
	if (!firstResponse) throw new Error(`Gateway method "${method}" completed without a response.`);
	const firstPayload = firstResponse.payload;
	if (options?.expectFinal !== true || firstPayload?.status !== "accepted") return firstResponse;
	return finalResponse ?? await new Promise((resolve, reject) => {
		resolveFinalResponse = resolve;
		const timeoutMs = typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) ? resolveSafeTimeoutDelayMs(options.timeoutMs) : void 0;
		const timeout = timeoutMs === void 0 ? void 0 : setTimeout(() => {
			reject(/* @__PURE__ */ new Error(`gateway request timeout for ${method}`));
		}, timeoutMs);
		if (finalResponse) {
			if (timeout) clearTimeout(timeout);
			resolve(finalResponse);
			return;
		}
		resolveFinalResponse = (response) => {
			if (timeout) clearTimeout(timeout);
			resolve(response);
		};
	});
}
async function dispatchGatewayMethod(method, params, options) {
	return unwrapGatewayMethodDispatchResponse(method, await dispatchGatewayMethodInProcessRaw(method, params, options));
}
async function dispatchGatewayMethodInProcess(method, params, options) {
	return await dispatchGatewayMethod(method, params, options);
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
	const started = performance.now();
	const activationAutoEnabled = params.activationSourceConfig !== void 0 && params.autoEnabledReasons === void 0 ? applyPluginAutoEnable({
		config: params.activationSourceConfig,
		env: process.env,
		...params.pluginLookUpTable?.manifestRegistry ? { manifestRegistry: params.pluginLookUpTable.manifestRegistry } : {}
	}) : void 0;
	const autoEnableMs = performance.now() - started;
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
	const resolvedConfigMs = performance.now() - started;
	const resolvedConfig = autoEnabled.config;
	const pluginIds = params.pluginIds ?? [...(params.pluginLookUpTable ?? loadPluginLookUpTable({
		config: resolvedConfig,
		activationSourceConfig: params.activationSourceConfig,
		workspaceDir: params.workspaceDir,
		env: process.env
	})).startup.pluginIds];
	const pluginIdsMs = performance.now() - started;
	if (pluginIds.length === 0) {
		clearActivatedPluginRuntimeState();
		const pluginRegistry = createEmptyPluginRegistry();
		setActivePluginRegistry(pluginRegistry, void 0, "gateway-bindable", params.workspaceDir);
		params.startupTrace?.detail("plugins.gateway-load", [
			["autoEnableMs", autoEnableMs],
			["resolvedConfigMs", resolvedConfigMs],
			["pluginIdsMs", pluginIdsMs],
			["loadMs", 0],
			["pluginIds", "0"],
			["pluginCount", 0],
			["gatewayHandlerCount", 0]
		]);
		return {
			pluginRegistry,
			gatewayMethods: [...params.baseMethods]
		};
	}
	const beforeLoad = performance.now();
	const loaderStatsBefore = getPluginModuleLoaderStats();
	const pluginRegistry = loadOpenClawPlugins({
		config: resolvedConfig,
		activationSourceConfig: params.activationSourceConfig ?? params.cfg,
		autoEnabledReasons: autoEnabled.autoEnabledReasons,
		workspaceDir: params.workspaceDir,
		onlyPluginIds: pluginIds,
		logger: createGatewayPluginRegistrationLogger({ suppressInfoLogs: params.suppressPluginInfoLogs }),
		...params.coreGatewayHandlers !== void 0 && { coreGatewayHandlers: params.coreGatewayHandlers },
		...params.coreGatewayMethodNames !== void 0 && { coreGatewayMethodNames: params.coreGatewayMethodNames },
		...params.hostServices !== void 0 && { hostServices: params.hostServices },
		runtimeOptions: { allowGatewaySubagentBinding: true },
		preferSetupRuntimeForChannelPlugins: params.preferSetupRuntimeForChannelPlugins,
		preferBuiltPluginArtifacts: true,
		...params.startupTrace !== void 0 && { startupTrace: params.startupTrace },
		...params.pluginLookUpTable?.manifestRegistry ? { manifestRegistry: params.pluginLookUpTable.manifestRegistry } : {}
	});
	const loadMs = performance.now() - beforeLoad;
	const loaderStatsAfter = getPluginModuleLoaderStats();
	const pluginMethods = Object.keys(pluginRegistry.gatewayHandlers);
	const gatewayMethods = Array.from(new Set([...params.baseMethods, ...pluginMethods]));
	params.startupTrace?.detail("plugins.gateway-load", [
		["autoEnableMs", autoEnableMs],
		["resolvedConfigMs", resolvedConfigMs],
		["pluginIdsMs", pluginIdsMs],
		["loadMs", loadMs],
		["pluginIds", String(pluginIds.length)],
		["pluginCount", pluginIds.length],
		["gatewayHandlers", String(pluginMethods.length)],
		["gatewayHandlerCount", pluginMethods.length],
		["loaderCallsCount", loaderStatsAfter.calls - loaderStatsBefore.calls],
		["loaderNativeHitsCount", loaderStatsAfter.nativeHits - loaderStatsBefore.nativeHits],
		["loaderNativeMissesCount", loaderStatsAfter.nativeMisses - loaderStatsBefore.nativeMisses],
		["loaderSourceTransformForcedCount", loaderStatsAfter.sourceTransformForced - loaderStatsBefore.sourceTransformForced],
		["loaderSourceTransformFallbacksCount", loaderStatsAfter.sourceTransformFallbacks - loaderStatsBefore.sourceTransformFallbacks],
		["loaderTopSourceTransformTargets", loaderStatsAfter.topSourceTransformTargets.slice(0, 3).map((entry) => `${entry.count}:${entry.target}`).join(",")]
	]);
	return {
		pluginRegistry,
		gatewayMethods
	};
}
//#endregion
export { loadGatewayPlugins as a, dispatchGatewayMethodInProcessRaw as i, createGatewaySubagentRuntime as n, setFallbackGatewayContextResolver as o, dispatchGatewayMethodInProcess as r, setPluginSubagentOverridePolicies as s, createGatewayNodesRuntime as t };

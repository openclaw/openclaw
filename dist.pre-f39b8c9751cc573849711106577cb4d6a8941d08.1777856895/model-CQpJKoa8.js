import { s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { n as findNormalizedProviderValue, r as normalizeProviderId } from "./provider-id-dd60CFPS.js";
import "./defaults-DNihGLJv.js";
import { G as shouldPreferProviderRuntimeResolvedModel, H as runProviderDynamicModel, _ as normalizeProviderResolvedModelWithPlugin, a as applyProviderResolvedTransportWithPlugin, b as prepareProviderDynamicModel, i as applyProviderResolvedModelCompatWithPlugins, l as buildProviderUnknownModelHintWithPlugin, y as normalizeProviderTransportWithPlugin } from "./provider-runtime-7IfUFCM-.js";
import { t as resolveOpenClawAgentDir } from "./agent-paths-Dxsp8o8C.js";
import { n as modelKey, r as normalizeStaticProviderModelId } from "./model-ref-shared-BZrmhbFC.js";
import "./model-selection-DqTgZ6sy.js";
import { s as resolveProviderRequestConfig, t as attachModelProviderRequestTransport, u as sanitizeConfiguredModelProviderRequest } from "./provider-request-config-DT1B_A_J.js";
import { f as isSecretRefHeaderValueMarker } from "./model-auth-markers-Csuhcf6v.js";
import { a as normalizeModelCompat } from "./provider-model-compat-77Mi9w2y.js";
import { i as discoverModels, r as discoverAuthStorage } from "./pi-model-discovery-DD_PdqIh.js";
import { n as normalizeGoogleApiBaseUrl } from "./google-api-base-url-m0a57oiY.js";
import { a as shouldUnconditionallySuppress, n as buildSuppressedBuiltInModelError, r as shouldSuppressBuiltInModel } from "./model-suppression-D6kWHlla.js";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
//#region src/agents/pi-embedded-runner/model.inline-provider.ts
function normalizeResolvedTransportApi(api) {
	switch (api) {
		case "anthropic-messages":
		case "bedrock-converse-stream":
		case "github-copilot":
		case "google-generative-ai":
		case "ollama":
		case "openai-codex-responses":
		case "openai-completions":
		case "openai-responses":
		case "azure-openai-responses": return api;
		default: return;
	}
}
function sanitizeModelHeaders(headers, opts) {
	if (!headers || typeof headers !== "object" || Array.isArray(headers)) return;
	const next = {};
	for (const [headerName, headerValue] of Object.entries(headers)) {
		if (typeof headerValue !== "string") continue;
		if (opts?.stripSecretRefMarkers && isSecretRefHeaderValueMarker(headerValue)) continue;
		next[headerName] = headerValue;
	}
	return Object.keys(next).length > 0 ? next : void 0;
}
function isLegacyFoundryVisionModelCandidate(params) {
	if (normalizeOptionalLowercaseString(params.provider) !== "microsoft-foundry") return false;
	return [params.modelId, params.modelName].filter((value) => typeof value === "string").map((value) => normalizeOptionalLowercaseString(value)).filter((value) => Boolean(value)).some((candidate) => candidate.startsWith("gpt-") || candidate.startsWith("o1") || candidate.startsWith("o3") || candidate.startsWith("o4") || candidate === "computer-use-preview");
}
function resolveProviderModelInput(params) {
	const resolvedInput = Array.isArray(params.input) ? params.input : params.fallbackInput;
	const normalizedInput = Array.isArray(resolvedInput) ? resolvedInput.filter((item) => item === "text" || item === "image") : [];
	if (normalizedInput.length > 0 && !normalizedInput.includes("image") && isLegacyFoundryVisionModelCandidate(params)) return ["text", "image"];
	return normalizedInput.length > 0 ? normalizedInput : ["text"];
}
function resolveInlineProviderTransport(params) {
	const api = normalizeResolvedTransportApi(params.api);
	return {
		api,
		baseUrl: api === "google-generative-ai" ? normalizeGoogleApiBaseUrl(params.baseUrl) : params.baseUrl
	};
}
function buildInlineProviderModels(providers) {
	return Object.entries(providers).flatMap(([providerId, entry]) => {
		const trimmed = providerId.trim();
		if (!trimmed) return [];
		const providerHeaders = sanitizeModelHeaders(entry?.headers, { stripSecretRefMarkers: true });
		const providerRequest = sanitizeConfiguredModelProviderRequest(entry?.request);
		return (entry?.models ?? []).map((model) => {
			const transport = resolveInlineProviderTransport({
				api: model.api ?? entry?.api,
				baseUrl: entry?.baseUrl
			});
			const modelHeaders = sanitizeModelHeaders(model.headers, { stripSecretRefMarkers: true });
			const requestConfig = resolveProviderRequestConfig({
				provider: trimmed,
				api: transport.api ?? model.api,
				baseUrl: transport.baseUrl,
				providerHeaders,
				modelHeaders,
				authHeader: entry?.authHeader,
				request: providerRequest,
				capability: "llm",
				transport: "stream"
			});
			return attachModelProviderRequestTransport({
				...model,
				contextWindow: model.contextWindow ?? entry?.contextWindow,
				contextTokens: model.contextTokens ?? entry?.contextTokens,
				maxTokens: model.maxTokens ?? entry?.maxTokens,
				input: resolveProviderModelInput({
					provider: trimmed,
					modelId: model.id,
					modelName: model.name,
					input: model.input
				}),
				provider: trimmed,
				baseUrl: requestConfig.baseUrl ?? transport.baseUrl,
				api: requestConfig.api ?? model.api,
				headers: requestConfig.headers
			}, providerRequest);
		});
	});
}
//#endregion
//#region src/agents/pi-embedded-runner/model.provider-normalization.ts
function normalizeResolvedProviderModel(params) {
	return normalizeModelCompat(params.model);
}
//#endregion
//#region src/agents/pi-embedded-runner/model.ts
const TARGET_PROVIDER_RUNTIME_HOOKS = {
	buildProviderUnknownModelHintWithPlugin,
	prepareProviderDynamicModel,
	runProviderDynamicModel,
	shouldPreferProviderRuntimeResolvedModel,
	normalizeProviderResolvedModelWithPlugin,
	applyProviderResolvedModelCompatWithPlugins: () => void 0,
	applyProviderResolvedTransportWithPlugin: () => void 0,
	normalizeProviderTransportWithPlugin: () => void 0
};
const DEFAULT_PROVIDER_RUNTIME_HOOKS = {
	...TARGET_PROVIDER_RUNTIME_HOOKS,
	applyProviderResolvedModelCompatWithPlugins,
	applyProviderResolvedTransportWithPlugin,
	normalizeProviderTransportWithPlugin
};
const STATIC_PROVIDER_RUNTIME_HOOKS = {
	applyProviderResolvedModelCompatWithPlugins: () => void 0,
	applyProviderResolvedTransportWithPlugin: () => void 0,
	buildProviderUnknownModelHintWithPlugin: () => void 0,
	prepareProviderDynamicModel: async () => {},
	runProviderDynamicModel: () => void 0,
	normalizeProviderResolvedModelWithPlugin: () => void 0,
	normalizeProviderTransportWithPlugin: () => void 0
};
const SKIP_PI_DISCOVERY_PROVIDER_RUNTIME_HOOKS = { ...TARGET_PROVIDER_RUNTIME_HOOKS };
function createEmptyPiDiscoveryStores() {
	const authStorage = typeof AuthStorage.inMemory === "function" ? AuthStorage.inMemory({}) : AuthStorage.create();
	return {
		authStorage,
		modelRegistry: typeof ModelRegistry.inMemory === "function" ? ModelRegistry.inMemory(authStorage) : ModelRegistry.create(authStorage)
	};
}
function resolveRuntimeHooks(params) {
	if (params?.skipProviderRuntimeHooks) return STATIC_PROVIDER_RUNTIME_HOOKS;
	if (params?.runtimeHooks) return params.runtimeHooks;
	if (params?.skipPiDiscovery) return SKIP_PI_DISCOVERY_PROVIDER_RUNTIME_HOOKS;
	return DEFAULT_PROVIDER_RUNTIME_HOOKS;
}
function canonicalizeLegacyResolvedModel(params) {
	if (normalizeProviderId(params.provider) !== "openai-codex" || params.model.id.trim().toLowerCase() !== "gpt-5.4-codex") return params.model;
	return {
		...params.model,
		id: "gpt-5.4",
		name: params.model.name.trim().toLowerCase() === "gpt-5.4-codex" ? "gpt-5.4" : params.model.name
	};
}
function applyResolvedTransportFallback(params) {
	const normalized = params.runtimeHooks.normalizeProviderTransportWithPlugin({
		provider: params.provider,
		config: params.cfg,
		context: {
			provider: params.provider,
			api: params.model.api,
			baseUrl: params.model.baseUrl
		}
	});
	if (!normalized) return;
	const nextApi = normalizeResolvedTransportApi(normalized.api) ?? params.model.api;
	const nextBaseUrl = normalized.baseUrl ?? params.model.baseUrl;
	if (nextApi === params.model.api && nextBaseUrl === params.model.baseUrl) return;
	return {
		...params.model,
		api: nextApi,
		baseUrl: nextBaseUrl
	};
}
function normalizeResolvedModel(params) {
	const normalizeModelCost = (cost) => {
		if (!cost || typeof cost !== "object" || Array.isArray(cost)) return {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		};
		const record = cost;
		const input = typeof record.input === "number" && Number.isFinite(record.input) ? record.input : 0;
		const output = typeof record.output === "number" && Number.isFinite(record.output) ? record.output : 0;
		const cacheRead = typeof record.cacheRead === "number" && Number.isFinite(record.cacheRead) ? record.cacheRead : 0;
		const cacheWrite = typeof record.cacheWrite === "number" && Number.isFinite(record.cacheWrite) ? record.cacheWrite : 0;
		if (input === record.input && output === record.output && cacheRead === record.cacheRead && cacheWrite === record.cacheWrite) return record;
		return {
			...cost,
			input,
			output,
			cacheRead,
			cacheWrite
		};
	};
	const normalizedInputModel = {
		...params.model,
		input: resolveProviderModelInput({
			provider: params.provider,
			modelId: params.model.id,
			modelName: params.model.name,
			input: params.model.input
		}),
		cost: normalizeModelCost(params.model.cost)
	};
	const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
	const pluginNormalized = runtimeHooks.normalizeProviderResolvedModelWithPlugin({
		provider: params.provider,
		config: params.cfg,
		context: {
			config: params.cfg,
			agentDir: params.agentDir,
			provider: params.provider,
			modelId: normalizedInputModel.id,
			model: normalizedInputModel
		}
	});
	const compatNormalized = runtimeHooks.applyProviderResolvedModelCompatWithPlugins?.({
		provider: params.provider,
		config: params.cfg,
		context: {
			config: params.cfg,
			agentDir: params.agentDir,
			provider: params.provider,
			modelId: normalizedInputModel.id,
			model: pluginNormalized ?? normalizedInputModel
		}
	});
	const fallbackTransportNormalized = runtimeHooks.applyProviderResolvedTransportWithPlugin?.({
		provider: params.provider,
		config: params.cfg,
		context: {
			config: params.cfg,
			agentDir: params.agentDir,
			provider: params.provider,
			modelId: normalizedInputModel.id,
			model: compatNormalized ?? pluginNormalized ?? normalizedInputModel
		}
	}) ?? applyResolvedTransportFallback({
		provider: params.provider,
		cfg: params.cfg,
		runtimeHooks,
		model: compatNormalized ?? pluginNormalized ?? normalizedInputModel
	});
	return canonicalizeLegacyResolvedModel({
		provider: params.provider,
		model: normalizeResolvedProviderModel({
			provider: params.provider,
			model: fallbackTransportNormalized ?? compatNormalized ?? pluginNormalized ?? normalizedInputModel
		})
	});
}
function resolveProviderTransport(params) {
	const normalized = (params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS).normalizeProviderTransportWithPlugin({
		provider: params.provider,
		config: params.cfg,
		context: {
			provider: params.provider,
			api: params.api,
			baseUrl: params.baseUrl
		}
	});
	return {
		api: normalizeResolvedTransportApi(normalized?.api ?? params.api),
		baseUrl: normalized?.baseUrl ?? params.baseUrl
	};
}
function resolveConfiguredProviderDefaultApi(providerConfig) {
	const explicit = normalizeResolvedTransportApi(providerConfig?.api);
	if (explicit) return explicit;
	return providerConfig?.baseUrl ? "openai-completions" : void 0;
}
function resolveProviderRequestTimeoutMs(timeoutSeconds) {
	if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return;
	return Math.floor(timeoutSeconds) * 1e3;
}
function matchesProviderScopedModelId(params) {
	const { candidateId, provider, modelId } = params;
	if (candidateId === modelId) return true;
	const slashIndex = candidateId?.indexOf("/") ?? -1;
	if (!candidateId || slashIndex <= 0) return false;
	const candidateProvider = candidateId.slice(0, slashIndex);
	return candidateId.slice(slashIndex + 1) === modelId && normalizeProviderId(candidateProvider) === normalizeProviderId(provider);
}
function findInlineModelMatch(params) {
	const matchesModelId = (entry) => matchesProviderScopedModelId({
		candidateId: entry.id,
		provider: entry.provider,
		modelId: params.modelId
	});
	const inlineModels = buildInlineProviderModels(params.providers);
	const exact = inlineModels.find((entry) => entry.provider === params.provider && matchesModelId(entry));
	if (exact) return exact;
	const normalizedProvider = normalizeProviderId(params.provider);
	return inlineModels.find((entry) => normalizeProviderId(entry.provider) === normalizedProvider && matchesModelId(entry));
}
function resolveConfiguredProviderConfig(cfg, provider) {
	const configuredProviders = cfg?.models?.providers;
	if (!configuredProviders) return;
	const exactProviderConfig = configuredProviders[provider];
	if (exactProviderConfig) return exactProviderConfig;
	return findNormalizedProviderValue(configuredProviders, provider);
}
function isModelsAddMetadataModel(params) {
	return params.model?.metadataSource === "models-add";
}
function findConfiguredProviderModel(providerConfig, provider, modelId) {
	return providerConfig?.models?.find((candidate) => matchesProviderScopedModelId({
		candidateId: candidate.id,
		provider,
		modelId
	}));
}
function readModelParams(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function mergeModelParams(...entries) {
	const merged = Object.assign({}, ...entries.filter(Boolean));
	return Object.keys(merged).length > 0 ? merged : void 0;
}
function findConfiguredAgentModelParams(params) {
	const configuredModels = params.cfg?.agents?.defaults?.models;
	if (!configuredModels) return;
	const directKeys = [modelKey(params.provider, params.modelId), `${params.provider}/${params.modelId}`];
	for (const key of directKeys) {
		const direct = readModelParams(configuredModels[key]?.params);
		if (direct) return direct;
	}
	const normalizedProvider = normalizeProviderId(params.provider);
	const normalizedModelId = normalizeStaticProviderModelId(normalizedProvider, params.modelId).trim().toLowerCase();
	for (const [rawKey, entry] of Object.entries(configuredModels)) {
		const slashIndex = rawKey.indexOf("/");
		if (slashIndex <= 0) continue;
		const candidateProvider = rawKey.slice(0, slashIndex);
		const candidateModelId = rawKey.slice(slashIndex + 1);
		if (normalizeProviderId(candidateProvider) === normalizedProvider && normalizeStaticProviderModelId(normalizedProvider, candidateModelId).trim().toLowerCase() === normalizedModelId) return readModelParams(entry.params);
	}
}
function mergeConfiguredRuntimeModelParams(params) {
	return mergeModelParams(readModelParams(params.discoveredParams), findConfiguredAgentModelParams({
		cfg: params.cfg,
		provider: params.provider,
		modelId: params.modelId
	}), readModelParams(params.configuredParams));
}
function applyConfiguredProviderOverrides(params) {
	const { discoveredModel, providerConfig, modelId } = params;
	const requestTimeoutMs = resolveProviderRequestTimeoutMs(providerConfig?.timeoutSeconds);
	const defaultModelParams = findConfiguredAgentModelParams({
		cfg: params.cfg,
		provider: params.provider,
		modelId
	});
	if (!providerConfig) {
		const resolvedParams = mergeModelParams(readModelParams(discoveredModel.params), defaultModelParams);
		return {
			...discoveredModel,
			...resolvedParams ? { params: resolvedParams } : {},
			headers: sanitizeModelHeaders(discoveredModel.headers, { stripSecretRefMarkers: true })
		};
	}
	const configuredModel = findConfiguredProviderModel(providerConfig, params.provider, modelId) ?? (discoveredModel.id !== modelId ? findConfiguredProviderModel(providerConfig, params.provider, discoveredModel.id) : void 0);
	const metadataOverrideModel = params.preferDiscoveredModelMetadata && isModelsAddMetadataModel({ model: configuredModel }) ? void 0 : configuredModel;
	const discoveredHeaders = sanitizeModelHeaders(discoveredModel.headers, { stripSecretRefMarkers: true });
	const providerHeaders = sanitizeModelHeaders(providerConfig.headers, { stripSecretRefMarkers: true });
	const providerRequest = sanitizeConfiguredModelProviderRequest(providerConfig.request);
	const configuredHeaders = sanitizeModelHeaders(configuredModel?.headers, { stripSecretRefMarkers: true });
	if (!configuredModel && !providerConfig.baseUrl && !providerConfig.api && providerConfig.contextWindow === void 0 && providerConfig.contextTokens === void 0 && providerConfig.maxTokens === void 0 && requestTimeoutMs === void 0 && !providerHeaders && !providerRequest) {
		const resolvedParams = mergeModelParams(readModelParams(discoveredModel.params), defaultModelParams);
		return {
			...discoveredModel,
			...resolvedParams ? { params: resolvedParams } : {},
			...requestTimeoutMs !== void 0 ? { requestTimeoutMs } : {},
			headers: discoveredHeaders
		};
	}
	const resolvedParams = mergeModelParams(readModelParams(discoveredModel.params), defaultModelParams, readModelParams(configuredModel?.params));
	const normalizedInput = resolveProviderModelInput({
		provider: params.provider,
		modelId,
		modelName: metadataOverrideModel?.name ?? discoveredModel.name,
		input: metadataOverrideModel?.input,
		fallbackInput: discoveredModel.input
	});
	const resolvedTransport = resolveProviderTransport({
		provider: params.provider,
		api: metadataOverrideModel?.api ?? providerConfig.api ?? discoveredModel.api ?? resolveConfiguredProviderDefaultApi(providerConfig),
		baseUrl: providerConfig.baseUrl ?? discoveredModel.baseUrl,
		cfg: params.cfg,
		runtimeHooks: params.runtimeHooks
	});
	const resolvedContextWindow = metadataOverrideModel?.contextWindow ?? providerConfig.contextWindow;
	const resolvedMaxTokens = metadataOverrideModel?.maxTokens ?? providerConfig.maxTokens ?? discoveredModel.maxTokens;
	const requestConfig = resolveProviderRequestConfig({
		provider: params.provider,
		api: resolvedTransport.api ?? normalizeResolvedTransportApi(discoveredModel.api) ?? resolveConfiguredProviderDefaultApi(providerConfig) ?? "openai-responses",
		baseUrl: resolvedTransport.baseUrl ?? discoveredModel.baseUrl,
		discoveredHeaders,
		providerHeaders,
		modelHeaders: configuredHeaders,
		authHeader: providerConfig.authHeader,
		request: providerRequest,
		capability: "llm",
		transport: "stream"
	});
	return attachModelProviderRequestTransport({
		...discoveredModel,
		api: requestConfig.api ?? "openai-responses",
		baseUrl: requestConfig.baseUrl ?? discoveredModel.baseUrl,
		reasoning: metadataOverrideModel?.reasoning ?? discoveredModel.reasoning,
		input: normalizedInput,
		cost: metadataOverrideModel?.cost ?? discoveredModel.cost,
		contextWindow: resolvedContextWindow ?? discoveredModel.contextWindow,
		contextTokens: metadataOverrideModel?.contextTokens ?? providerConfig.contextTokens ?? discoveredModel.contextTokens,
		maxTokens: typeof resolvedContextWindow === "number" ? Math.min(resolvedMaxTokens, resolvedContextWindow) : resolvedMaxTokens,
		...resolvedParams ? { params: resolvedParams } : {},
		...requestTimeoutMs !== void 0 ? { requestTimeoutMs } : {},
		headers: requestConfig.headers,
		compat: metadataOverrideModel?.compat ?? discoveredModel.compat
	}, providerRequest);
}
function resolveExplicitModelWithRegistry(params) {
	const { provider, modelId, modelRegistry, cfg, agentDir, runtimeHooks } = params;
	const providerConfig = resolveConfiguredProviderConfig(cfg, provider);
	const requestTimeoutMs = resolveProviderRequestTimeoutMs(providerConfig?.timeoutSeconds);
	const inlineMatch = findInlineModelMatch({
		providers: cfg?.models?.providers ?? {},
		provider,
		modelId
	});
	if (inlineMatch?.api) {
		if (shouldUnconditionallySuppress({
			provider,
			id: modelId,
			config: cfg
		})) return { kind: "suppressed" };
		const resolvedParams = mergeConfiguredRuntimeModelParams({
			cfg,
			provider,
			modelId,
			configuredParams: inlineMatch.params
		});
		return {
			kind: "resolved",
			model: normalizeResolvedModel({
				provider,
				cfg,
				agentDir,
				model: {
					...inlineMatch,
					...resolvedParams ? { params: resolvedParams } : {},
					...requestTimeoutMs !== void 0 ? { requestTimeoutMs } : {}
				},
				runtimeHooks
			})
		};
	}
	if (shouldSuppressBuiltInModel({
		provider,
		id: modelId,
		baseUrl: providerConfig?.baseUrl,
		config: cfg
	})) return { kind: "suppressed" };
	const model = modelRegistry.find(provider, modelId);
	if (model) return {
		kind: "resolved",
		model: normalizeResolvedModel({
			provider,
			cfg,
			agentDir,
			model: applyConfiguredProviderOverrides({
				provider,
				discoveredModel: model,
				providerConfig,
				modelId,
				cfg,
				runtimeHooks
			}),
			runtimeHooks
		})
	};
	const fallbackInlineMatch = findInlineModelMatch({
		providers: cfg?.models?.providers ?? {},
		provider,
		modelId
	});
	if (fallbackInlineMatch?.api) {
		const resolvedParams = mergeConfiguredRuntimeModelParams({
			cfg,
			provider,
			modelId,
			configuredParams: fallbackInlineMatch.params
		});
		return {
			kind: "resolved",
			model: normalizeResolvedModel({
				provider,
				cfg,
				agentDir,
				model: {
					...fallbackInlineMatch,
					...resolvedParams ? { params: resolvedParams } : {},
					...requestTimeoutMs !== void 0 ? { requestTimeoutMs } : {}
				},
				runtimeHooks
			})
		};
	}
}
function resolvePluginDynamicModelWithRegistry(params) {
	const { provider, modelId, modelRegistry, cfg, agentDir, workspaceDir } = params;
	const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
	const providerConfig = resolveConfiguredProviderConfig(cfg, provider);
	const preferDiscoveredModelMetadata = shouldCompareProviderRuntimeResolvedModel({
		provider,
		modelId,
		cfg,
		agentDir,
		workspaceDir,
		runtimeHooks
	});
	const pluginDynamicModel = runtimeHooks.runProviderDynamicModel({
		provider,
		config: cfg,
		workspaceDir,
		context: {
			config: cfg,
			agentDir,
			provider,
			modelId,
			modelRegistry,
			providerConfig
		}
	});
	if (!pluginDynamicModel) return;
	return normalizeResolvedModel({
		provider,
		cfg,
		agentDir,
		model: applyConfiguredProviderOverrides({
			provider,
			discoveredModel: pluginDynamicModel,
			providerConfig,
			modelId,
			cfg,
			runtimeHooks,
			preferDiscoveredModelMetadata
		}),
		runtimeHooks
	});
}
function resolveConfiguredFallbackModel(params) {
	const { provider, modelId, cfg, agentDir, runtimeHooks } = params;
	const providerConfig = resolveConfiguredProviderConfig(cfg, provider);
	const requestTimeoutMs = resolveProviderRequestTimeoutMs(providerConfig?.timeoutSeconds);
	const configuredModel = findConfiguredProviderModel(providerConfig, provider, modelId);
	const providerHeaders = sanitizeModelHeaders(providerConfig?.headers, { stripSecretRefMarkers: true });
	const providerRequest = sanitizeConfiguredModelProviderRequest(providerConfig?.request);
	const modelHeaders = sanitizeModelHeaders(configuredModel?.headers, { stripSecretRefMarkers: true });
	const resolvedParams = mergeConfiguredRuntimeModelParams({
		cfg,
		provider,
		modelId,
		configuredParams: configuredModel?.params
	});
	if (!providerConfig && !modelId.startsWith("mock-")) return;
	const fallbackTransport = resolveProviderTransport({
		provider,
		api: resolveConfiguredProviderDefaultApi(providerConfig) ?? "openai-responses",
		baseUrl: providerConfig?.baseUrl,
		cfg,
		runtimeHooks
	});
	const requestConfig = resolveProviderRequestConfig({
		provider,
		api: fallbackTransport.api ?? "openai-responses",
		baseUrl: fallbackTransport.baseUrl,
		providerHeaders,
		modelHeaders,
		authHeader: providerConfig?.authHeader,
		request: providerRequest,
		capability: "llm",
		transport: "stream"
	});
	return normalizeResolvedModel({
		provider,
		cfg,
		agentDir,
		model: attachModelProviderRequestTransport({
			id: modelId,
			name: modelId,
			api: requestConfig.api ?? "openai-responses",
			provider,
			baseUrl: requestConfig.baseUrl,
			reasoning: configuredModel?.reasoning ?? false,
			input: resolveProviderModelInput({
				provider,
				modelId,
				modelName: configuredModel?.name ?? modelId,
				input: configuredModel?.input
			}),
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0
			},
			contextWindow: configuredModel?.contextWindow ?? providerConfig?.contextWindow ?? providerConfig?.models?.[0]?.contextWindow ?? 2e5,
			contextTokens: configuredModel?.contextTokens ?? providerConfig?.contextTokens ?? providerConfig?.models?.[0]?.contextTokens,
			maxTokens: configuredModel?.maxTokens ?? providerConfig?.maxTokens ?? providerConfig?.models?.[0]?.maxTokens ?? 2e5,
			...resolvedParams ? { params: resolvedParams } : {},
			...requestTimeoutMs !== void 0 ? { requestTimeoutMs } : {},
			headers: requestConfig.headers
		}, providerRequest),
		runtimeHooks
	});
}
function shouldCompareProviderRuntimeResolvedModel(params) {
	return params.runtimeHooks.shouldPreferProviderRuntimeResolvedModel?.({
		provider: params.provider,
		config: params.cfg,
		workspaceDir: params.workspaceDir,
		context: {
			provider: params.provider,
			modelId: params.modelId,
			config: params.cfg,
			agentDir: params.agentDir,
			workspaceDir: params.workspaceDir
		}
	}) ?? false;
}
function preferProviderRuntimeResolvedModel(params) {
	if (params.runtimeResolvedModel) return params.runtimeResolvedModel;
	return params.explicitModel;
}
function resolveModelWithRegistry(params) {
	const normalizedRef = {
		provider: params.provider,
		model: normalizeStaticProviderModelId(normalizeProviderId(params.provider), params.modelId)
	};
	const normalizedParams = {
		...params,
		provider: normalizedRef.provider,
		modelId: normalizedRef.model
	};
	const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
	const workspaceDir = normalizedParams.cfg?.agents?.defaults?.workspace;
	const explicitModel = resolveExplicitModelWithRegistry(normalizedParams);
	if (explicitModel?.kind === "suppressed") return;
	if (explicitModel?.kind === "resolved") {
		if (!shouldCompareProviderRuntimeResolvedModel({
			provider: normalizedParams.provider,
			modelId: normalizedParams.modelId,
			cfg: normalizedParams.cfg,
			agentDir: normalizedParams.agentDir,
			workspaceDir,
			runtimeHooks
		})) return explicitModel.model;
		const pluginDynamicModel = resolvePluginDynamicModelWithRegistry({
			...normalizedParams,
			workspaceDir
		});
		return preferProviderRuntimeResolvedModel({
			explicitModel: explicitModel.model,
			runtimeResolvedModel: pluginDynamicModel
		});
	}
	const pluginDynamicModel = resolvePluginDynamicModelWithRegistry(normalizedParams);
	if (pluginDynamicModel) return pluginDynamicModel;
	return resolveConfiguredFallbackModel(normalizedParams);
}
function resolveModel(provider, modelId, agentDir, cfg, options) {
	const normalizedRef = {
		provider,
		model: normalizeStaticProviderModelId(normalizeProviderId(provider), modelId)
	};
	const resolvedAgentDir = agentDir ?? resolveOpenClawAgentDir();
	const authStorage = options?.authStorage ?? discoverAuthStorage(resolvedAgentDir);
	const modelRegistry = options?.modelRegistry ?? discoverModels(authStorage, resolvedAgentDir);
	const runtimeHooks = resolveRuntimeHooks(options);
	const model = resolveModelWithRegistry({
		provider: normalizedRef.provider,
		modelId: normalizedRef.model,
		modelRegistry,
		cfg,
		agentDir: resolvedAgentDir,
		runtimeHooks
	});
	if (model) return {
		model,
		authStorage,
		modelRegistry
	};
	return {
		error: buildUnknownModelError({
			provider: normalizedRef.provider,
			modelId: normalizedRef.model,
			cfg,
			agentDir: resolvedAgentDir,
			runtimeHooks
		}),
		authStorage,
		modelRegistry
	};
}
async function resolveModelAsync(provider, modelId, agentDir, cfg, options) {
	const normalizedRef = {
		provider,
		model: normalizeStaticProviderModelId(normalizeProviderId(provider), modelId)
	};
	const resolvedAgentDir = agentDir ?? resolveOpenClawAgentDir();
	const emptyDiscoveryStores = options?.skipPiDiscovery && (!options.authStorage || !options.modelRegistry) ? createEmptyPiDiscoveryStores() : void 0;
	const authStorage = options?.authStorage ?? emptyDiscoveryStores?.authStorage ?? discoverAuthStorage(resolvedAgentDir);
	const modelRegistry = options?.modelRegistry ?? emptyDiscoveryStores?.modelRegistry ?? discoverModels(authStorage, resolvedAgentDir);
	const runtimeHooks = resolveRuntimeHooks(options);
	const explicitModel = resolveExplicitModelWithRegistry({
		provider: normalizedRef.provider,
		modelId: normalizedRef.model,
		modelRegistry,
		cfg,
		agentDir: resolvedAgentDir,
		runtimeHooks
	});
	if (explicitModel?.kind === "suppressed") return {
		error: buildUnknownModelError({
			provider: normalizedRef.provider,
			modelId: normalizedRef.model,
			cfg,
			agentDir: resolvedAgentDir,
			runtimeHooks
		}),
		authStorage,
		modelRegistry
	};
	const providerConfig = resolveConfiguredProviderConfig(cfg, normalizedRef.provider);
	const resolveDynamicAttempt = async () => {
		await runtimeHooks.prepareProviderDynamicModel({
			provider: normalizedRef.provider,
			config: cfg,
			context: {
				config: cfg,
				agentDir: resolvedAgentDir,
				provider: normalizedRef.provider,
				modelId: normalizedRef.model,
				modelRegistry,
				providerConfig
			}
		});
		return resolveModelWithRegistry({
			provider: normalizedRef.provider,
			modelId: normalizedRef.model,
			modelRegistry,
			cfg,
			agentDir: resolvedAgentDir,
			runtimeHooks
		});
	};
	let model = explicitModel?.kind === "resolved" && !shouldCompareProviderRuntimeResolvedModel({
		provider: normalizedRef.provider,
		modelId: normalizedRef.model,
		cfg,
		agentDir: resolvedAgentDir,
		runtimeHooks
	}) ? explicitModel.model : await resolveDynamicAttempt();
	if (!model && !explicitModel && options?.retryTransientProviderRuntimeMiss) model = await resolveDynamicAttempt();
	if (model) return {
		model,
		authStorage,
		modelRegistry
	};
	return {
		error: buildUnknownModelError({
			provider: normalizedRef.provider,
			modelId: normalizedRef.model,
			cfg,
			agentDir: resolvedAgentDir,
			runtimeHooks
		}),
		authStorage,
		modelRegistry
	};
}
/**
* Build a more helpful error when the model is not found.
*
* Some provider plugins only become available after setup/auth has registered
* them. When users point `agents.defaults.model.primary` at one of those
* providers before setup, the raw `Unknown model` error is too vague. Provider
* plugins can append a targeted recovery hint here.
*
* See: https://github.com/openclaw/openclaw/issues/17328
*/
function buildUnknownModelError(params) {
	const suppressed = buildSuppressedBuiltInModelError({
		provider: params.provider,
		id: params.modelId,
		config: params.cfg
	});
	if (suppressed) return suppressed;
	const base = `Unknown model: ${params.provider}/${params.modelId}`;
	const hint = (params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS).buildProviderUnknownModelHintWithPlugin({
		provider: params.provider,
		config: params.cfg,
		env: process.env,
		context: {
			config: params.cfg,
			agentDir: params.agentDir,
			env: process.env,
			provider: params.provider,
			modelId: params.modelId
		}
	});
	return hint ? `${base}. ${hint}` : base;
}
//#endregion
export { buildInlineProviderModels as i, resolveModelAsync as n, resolveModelWithRegistry as r, resolveModel as t };

import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import "./agent-scope-CtLXGcWm.js";
import { s as resolveDefaultAgentDir } from "./agent-scope-config-CMp71_27.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import "./config-B6Oplu5W.js";
import "./model-selection-P-81eBKx.js";
import { t as computeBackoff } from "./backoff-BQ4uO4hX.js";
//#region src/agents/context-cache.ts
const MODEL_CONTEXT_TOKEN_CACHE = /* @__PURE__ */ new Map();
function lookupCachedContextTokens(modelId) {
	if (!modelId) return;
	return MODEL_CONTEXT_TOKEN_CACHE.get(modelId);
}
//#endregion
//#region src/agents/context-runtime-state.ts
const CONTEXT_WINDOW_RUNTIME_STATE_KEY = Symbol.for("openclaw.contextWindowRuntimeState");
const CONTEXT_WINDOW_RUNTIME_STATE = (() => {
	const globalState = globalThis;
	if (!globalState[CONTEXT_WINDOW_RUNTIME_STATE_KEY]) globalState[CONTEXT_WINDOW_RUNTIME_STATE_KEY] = {
		loadPromise: null,
		configuredConfig: void 0,
		configLoadFailures: 0,
		nextConfigLoadAttemptAtMs: 0,
		modelsConfigRuntimeLoader: createLazyImportLoader(() => import("./agents/models-config.runtime.js"))
	};
	return globalState[CONTEXT_WINDOW_RUNTIME_STATE_KEY];
})();
function resetContextWindowCacheForTest() {
	CONTEXT_WINDOW_RUNTIME_STATE.loadPromise = null;
	CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig = void 0;
	CONTEXT_WINDOW_RUNTIME_STATE.configLoadFailures = 0;
	CONTEXT_WINDOW_RUNTIME_STATE.nextConfigLoadAttemptAtMs = 0;
	CONTEXT_WINDOW_RUNTIME_STATE.modelsConfigRuntimeLoader.clear();
	MODEL_CONTEXT_TOKEN_CACHE.clear();
}
//#endregion
//#region src/agents/context.ts
const ANTHROPIC_1M_MODEL_PREFIXES = ["claude-opus-4", "claude-sonnet-4"];
const CLAUDE_OPUS_47_MODEL_PREFIXES = ["claude-opus-4-7", "claude-opus-4.7"];
const ANTHROPIC_CONTEXT_1M_TOKENS = 1048576;
const CONFIG_LOAD_RETRY_POLICY = {
	initialMs: 1e3,
	maxMs: 6e4,
	factor: 2,
	jitter: 0
};
function applyDiscoveredContextWindows(params) {
	for (const model of params.models) {
		if (!model?.id) continue;
		const discoveredContextTokens = typeof model.contextTokens === "number" ? Math.trunc(model.contextTokens) : typeof model.contextWindow === "number" ? Math.trunc(model.contextWindow) : void 0;
		const contextTokens = shouldUseDiscoveredAnthropicOpus47ContextWindow(model) ? ANTHROPIC_CONTEXT_1M_TOKENS : discoveredContextTokens;
		if (!contextTokens || contextTokens <= 0) continue;
		const existing = params.cache.get(model.id);
		if (existing === void 0 || contextTokens < existing) params.cache.set(model.id, contextTokens);
	}
}
function applyConfiguredContextWindows(params) {
	const providers = params.modelsConfig?.providers;
	if (!providers || typeof providers !== "object") return;
	for (const provider of Object.values(providers)) {
		if (!Array.isArray(provider?.models)) continue;
		for (const model of provider.models) {
			const modelId = typeof model?.id === "string" ? model.id : void 0;
			const contextTokens = typeof model?.contextTokens === "number" ? model.contextTokens : typeof model?.contextWindow === "number" ? model.contextWindow : typeof provider?.contextTokens === "number" ? provider.contextTokens : typeof provider?.contextWindow === "number" ? provider.contextWindow : void 0;
			if (!modelId || !contextTokens || contextTokens <= 0) continue;
			params.cache.set(modelId, contextTokens);
		}
	}
}
function loadModelsConfigRuntime() {
	return CONTEXT_WINDOW_RUNTIME_STATE.modelsConfigRuntimeLoader.load();
}
function primeConfiguredContextWindows() {
	if (CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig) {
		applyConfiguredContextWindows({
			cache: MODEL_CONTEXT_TOKEN_CACHE,
			modelsConfig: CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig.models
		});
		return CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig;
	}
	if (Date.now() < CONTEXT_WINDOW_RUNTIME_STATE.nextConfigLoadAttemptAtMs) return;
	try {
		const cfg = getRuntimeConfig();
		applyConfiguredContextWindows({
			cache: MODEL_CONTEXT_TOKEN_CACHE,
			modelsConfig: cfg.models
		});
		CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig = cfg;
		CONTEXT_WINDOW_RUNTIME_STATE.configLoadFailures = 0;
		CONTEXT_WINDOW_RUNTIME_STATE.nextConfigLoadAttemptAtMs = 0;
		return cfg;
	} catch {
		CONTEXT_WINDOW_RUNTIME_STATE.configLoadFailures += 1;
		const backoffMs = computeBackoff(CONFIG_LOAD_RETRY_POLICY, CONTEXT_WINDOW_RUNTIME_STATE.configLoadFailures);
		CONTEXT_WINDOW_RUNTIME_STATE.nextConfigLoadAttemptAtMs = Date.now() + backoffMs;
		return;
	}
}
function ensureContextWindowCacheLoaded() {
	if (CONTEXT_WINDOW_RUNTIME_STATE.loadPromise) return CONTEXT_WINDOW_RUNTIME_STATE.loadPromise;
	const cfg = primeConfiguredContextWindows();
	if (!cfg) return Promise.resolve();
	CONTEXT_WINDOW_RUNTIME_STATE.loadPromise = (async () => {
		try {
			await (await loadModelsConfigRuntime()).ensureOpenClawModelsJson(cfg);
		} catch {}
		try {
			const { discoverAuthStorage, discoverModels } = await import("./agents/pi-model-discovery-runtime.js");
			const agentDir = resolveDefaultAgentDir(cfg);
			const modelRegistry = discoverModels(discoverAuthStorage(agentDir), agentDir, { normalizeModels: false });
			applyDiscoveredContextWindows({
				cache: MODEL_CONTEXT_TOKEN_CACHE,
				models: typeof modelRegistry.getAvailable === "function" ? modelRegistry.getAvailable() : modelRegistry.getAll()
			});
		} catch {}
		applyConfiguredContextWindows({
			cache: MODEL_CONTEXT_TOKEN_CACHE,
			modelsConfig: cfg.models
		});
	})().catch(() => {});
	return CONTEXT_WINDOW_RUNTIME_STATE.loadPromise;
}
function lookupContextTokens(modelId, options) {
	if (!modelId) return;
	if (options?.skipRuntimeConfigLoad) return lookupCachedContextTokens(modelId);
	if (options?.allowAsyncLoad === false) primeConfiguredContextWindows();
	else ensureContextWindowCacheLoaded();
	return lookupCachedContextTokens(modelId);
}
function resolveProviderModelRef(params) {
	const modelRaw = params.model?.trim();
	if (!modelRaw) return;
	const providerRaw = params.provider?.trim();
	if (providerRaw) {
		const provider = normalizeProviderId(providerRaw);
		if (!provider) return;
		return {
			provider,
			model: modelRaw
		};
	}
	const slash = modelRaw.indexOf("/");
	if (slash <= 0) return;
	const provider = normalizeProviderId(modelRaw.slice(0, slash));
	const model = modelRaw.slice(slash + 1).trim();
	if (!provider || !model) return;
	return {
		provider,
		model
	};
}
function resolveConfiguredProviderContextTokens(cfg, provider, model) {
	const providers = (cfg?.models)?.providers;
	if (!providers) return;
	function readProviderContextTokens(providerConfig) {
		return typeof providerConfig?.contextTokens === "number" ? providerConfig.contextTokens : typeof providerConfig?.contextWindow === "number" ? providerConfig.contextWindow : void 0;
	}
	function findContextTokens(matchProviderId) {
		for (const [providerId, providerConfig] of Object.entries(providers)) {
			if (!matchProviderId(providerId)) continue;
			if (Array.isArray(providerConfig?.models)) for (const m of providerConfig.models) {
				const contextTokens = typeof m?.contextTokens === "number" ? m.contextTokens : typeof m?.contextWindow === "number" ? m.contextWindow : void 0;
				if (typeof m?.id === "string" && m.id === model && typeof contextTokens === "number" && contextTokens > 0) return contextTokens;
			}
			const providerContextTokens = readProviderContextTokens(providerConfig);
			if (typeof providerContextTokens === "number" && providerContextTokens > 0) return providerContextTokens;
		}
	}
	const exactResult = findContextTokens((id) => normalizeLowercaseStringOrEmpty(id) === normalizeLowercaseStringOrEmpty(provider));
	if (exactResult !== void 0) return exactResult;
	const normalizedProvider = normalizeProviderId(provider);
	return findContextTokens((id) => normalizeProviderId(id) === normalizedProvider);
}
function isAnthropic1MModel(provider, model) {
	if (provider !== "anthropic" && provider !== "claude-cli") return false;
	const modelId = resolveModelFamilyId(model);
	return ANTHROPIC_1M_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}
function shouldUseAnthropicOpus47ContextWindow(params) {
	const provider = params.provider ? normalizeProviderId(params.provider) : "";
	return (provider === "anthropic" || provider === "claude-cli") && isClaudeOpus47Model(params.model);
}
function shouldUseDiscoveredAnthropicOpus47ContextWindow(model) {
	const provider = typeof model.provider === "string" ? normalizeProviderId(model.provider) : void 0;
	const modelId = model.id;
	if (!isClaudeOpus47Model(modelId)) return false;
	if (provider) return provider === "anthropic" || provider === "claude-cli";
	const normalized = normalizeLowercaseStringOrEmpty(modelId);
	const slash = normalized.indexOf("/");
	if (slash < 0) return false;
	return normalizeProviderId(normalized.slice(0, slash)) === "claude-cli";
}
function resolveModelFamilyId(modelId) {
	const normalized = normalizeLowercaseStringOrEmpty(modelId);
	return normalized.includes("/") ? normalized.split("/").at(-1) ?? normalized : normalized;
}
function isClaudeOpus47Model(model) {
	const modelId = resolveModelFamilyId(model);
	return CLAUDE_OPUS_47_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}
function resolveContextTokensForModel(params) {
	if (typeof params.contextTokensOverride === "number" && params.contextTokensOverride > 0) return params.contextTokensOverride;
	const ref = resolveProviderModelRef({
		provider: params.provider,
		model: params.model
	});
	const explicitProvider = params.provider?.trim();
	if (ref) {
		if (explicitProvider && isAnthropic1MModel(ref.provider, ref.model)) return ANTHROPIC_CONTEXT_1M_TOKENS;
		if (explicitProvider) {
			const configuredWindow = resolveConfiguredProviderContextTokens(params.cfg, explicitProvider, ref.model);
			if (configuredWindow !== void 0) return configuredWindow;
		}
	}
	if (explicitProvider && ref && shouldUseAnthropicOpus47ContextWindow(ref)) return ANTHROPIC_CONTEXT_1M_TOKENS;
	if (params.provider && ref && !ref.model.includes("/")) {
		const qualifiedResult = lookupContextTokens(`${normalizeProviderId(ref.provider)}/${ref.model}`, {
			allowAsyncLoad: params.allowAsyncLoad,
			skipRuntimeConfigLoad: Boolean(params.cfg)
		});
		if (qualifiedResult !== void 0) return qualifiedResult;
	}
	const bareResult = lookupContextTokens(params.model, {
		allowAsyncLoad: params.allowAsyncLoad,
		skipRuntimeConfigLoad: Boolean(params.cfg)
	});
	if (bareResult !== void 0) return bareResult;
	if (!params.provider && ref && !ref.model.includes("/")) {
		const qualifiedResult = lookupContextTokens(`${normalizeProviderId(ref.provider)}/${ref.model}`, {
			allowAsyncLoad: params.allowAsyncLoad,
			skipRuntimeConfigLoad: Boolean(params.cfg)
		});
		if (qualifiedResult !== void 0) return qualifiedResult;
	}
	return params.fallbackContextTokens;
}
//#endregion
export { lookupContextTokens as a, ensureContextWindowCacheLoaded as i, applyConfiguredContextWindows as n, resolveContextTokensForModel as o, applyDiscoveredContextWindows as r, resetContextWindowCacheForTest as s, ANTHROPIC_CONTEXT_1M_TOKENS as t };

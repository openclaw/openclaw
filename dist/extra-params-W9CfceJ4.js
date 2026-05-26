import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { Y as prepareProviderExtraParams, Z as resolveProviderExtraParamsForTransport, tt as wrapProviderStreamFn } from "./provider-runtime-DXB7r8u2.js";
import { n as modelKey, t as legacyModelKey } from "./model-selection-normalize-B4tdZ1L4.js";
import { c as resolveProviderRequestPolicyConfig } from "./provider-request-config-DgQ_QSz5.js";
import { t as log } from "./logger-8oA4pYXO.js";
import { i as streamWithPayloadPatch } from "./moonshot-thinking-stream-wrappers-DY0RTUKY.js";
import { c as createOpenAICompletionsToolsCompatWrapper, f as createOpenAIResponsesContextManagementWrapper, m as createOpenAIStringContentWrapper, n as createOpenRouterSystemCacheWrapper, s as createOpenAICompletionsStrictMessageKeysWrapper, w as resolveAnthropicCacheRetentionFamily, x as createMinimaxThinkingDisabledWrapper } from "./proxy-stream-wrappers-CIFovY1X.js";
import { i as createGoogleThinkingPayloadWrapper, r as createDeepSeekV4OpenAICompatibleThinkingWrapper } from "./provider-stream-shared-BMzmRA_f.js";
import { streamSimple } from "@earendil-works/pi-ai";
//#region src/agents/pi-embedded-runner/prompt-cache-retention.ts
function isGooglePromptCacheEligible(params) {
	if (params.modelApi !== "google-generative-ai") return false;
	const normalizedModelId = normalizeLowercaseStringOrEmpty(params.modelId);
	return normalizedModelId.startsWith("gemini-2.5") || normalizedModelId.startsWith("gemini-3");
}
function resolveCacheRetention(extraParams, provider, modelApi, modelId) {
	const family = resolveAnthropicCacheRetentionFamily({
		provider,
		modelApi,
		modelId,
		hasExplicitCacheConfig: extraParams?.cacheRetention !== void 0 || extraParams?.cacheControlTtl !== void 0
	});
	const googleEligible = isGooglePromptCacheEligible({
		modelApi,
		modelId
	});
	if (!family && !googleEligible) return;
	const newVal = extraParams?.cacheRetention;
	if (newVal === "none" || newVal === "short" || newVal === "long") return newVal;
	const legacy = extraParams?.cacheControlTtl;
	if (legacy === "5m") return "short";
	if (legacy === "1h") return "long";
	return family === "anthropic-direct" ? "short" : void 0;
}
//#endregion
//#region src/agents/provider-api-families.ts
const GPT_PARALLEL_TOOL_CALLS_APIS = new Set([
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses"
]);
function supportsGptParallelToolCallsPayload(api) {
	return typeof api === "string" && GPT_PARALLEL_TOOL_CALLS_APIS.has(api);
}
//#endregion
//#region src/agents/pi-embedded-runner/moonshot-stream-wrappers.ts
function shouldApplySiliconFlowThinkingOffCompat(params) {
	return params.provider === "siliconflow" && params.thinkingLevel === "off" && params.modelId.startsWith("Pro/");
}
function createSiliconFlowThinkingWrapper(baseStreamFn) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
		if (payloadObj.thinking === "off") payloadObj.thinking = null;
	});
}
const providerRuntimeDeps = {
	prepareProviderExtraParams,
	resolveProviderExtraParamsForTransport,
	wrapProviderStreamFn
};
let preparedExtraParamsCache = /* @__PURE__ */ new WeakMap();
/**
* Resolve provider-specific extra params from model config.
* Used to pass through stream params like temperature/maxTokens.
*
* @internal Exported for testing only
*/
function resolveExtraParams(params) {
	const defaultParams = params.cfg?.agents?.defaults?.params ?? void 0;
	const canonicalKey = modelKey(params.provider, params.modelId);
	const legacyKey = legacyModelKey(params.provider, params.modelId);
	const configuredModels = params.cfg?.agents?.defaults?.models;
	const modelConfig = configuredModels?.[canonicalKey] ?? (legacyKey ? configuredModels?.[legacyKey] : void 0);
	const globalParams = modelConfig?.params ? { ...modelConfig.params } : void 0;
	const agentParams = params.agentId && params.cfg?.agents?.list ? params.cfg.agents.list.find((agent) => agent.id === params.agentId)?.params : void 0;
	const merged = Object.assign({}, defaultParams, globalParams, agentParams);
	const resolvedParallelToolCalls = resolveAliasedParamValue([
		defaultParams,
		globalParams,
		agentParams
	], "parallel_tool_calls", "parallelToolCalls");
	if (resolvedParallelToolCalls !== void 0) {
		merged.parallel_tool_calls = resolvedParallelToolCalls;
		delete merged.parallelToolCalls;
	}
	const resolvedTextVerbosity = resolveAliasedParamValue([globalParams, agentParams], "text_verbosity", "textVerbosity");
	if (resolvedTextVerbosity !== void 0) {
		merged.text_verbosity = resolvedTextVerbosity;
		delete merged.textVerbosity;
	}
	const resolvedCachedContent = resolveAliasedParamValue([
		defaultParams,
		globalParams,
		agentParams
	], "cached_content", "cachedContent");
	if (resolvedCachedContent !== void 0) {
		merged.cachedContent = resolvedCachedContent;
		delete merged.cached_content;
	}
	if (params.provider === "openrouter") canonicalizeOpenRouterResponseCacheParams(merged, [
		defaultParams,
		globalParams,
		agentParams
	]);
	applyDefaultOpenAIGptRuntimeParams(params, merged);
	return Object.keys(merged).length > 0 ? merged : void 0;
}
function resolveSupportedTransport(value) {
	return value === "sse" || value === "websocket" || value === "auto" ? value : void 0;
}
function hasExplicitTransportSetting(settings) {
	return Object.hasOwn(settings, "transport");
}
function fingerprintPreparedExtraParamsModel(model) {
	if (!model) return null;
	const record = model;
	return {
		api: model.api,
		provider: model.provider,
		id: model.id,
		name: model.name,
		baseUrl: model.baseUrl,
		reasoning: model.reasoning,
		input: model.input,
		cost: model.cost,
		compat: record.compat ?? null,
		contextWindow: model.contextWindow,
		contextTokens: model.contextTokens ?? null,
		headers: record.headers ?? null,
		maxTokens: model.maxTokens,
		params: model.params ?? null,
		requestTimeoutMs: model.requestTimeoutMs ?? null
	};
}
function resolvePreparedExtraParamsCacheKey(params) {
	return JSON.stringify({
		provider: params.provider,
		modelId: params.modelId,
		agentId: params.agentId ?? "",
		agentDir: params.agentDir ?? "",
		workspaceDir: params.workspaceDir ?? "",
		thinkingLevel: params.thinkingLevel ?? "",
		resolvedTransport: params.resolvedTransport ?? "",
		extraParamsOverride: params.extraParamsOverride ?? null,
		resolvedExtraParams: params.resolvedExtraParams ?? null,
		model: fingerprintPreparedExtraParamsModel(params.model)
	});
}
function resolvePreparedExtraParams(params) {
	const resolvedExtraParams = params.resolvedExtraParams ?? resolveExtraParams({
		cfg: params.cfg,
		provider: params.provider,
		modelId: params.modelId,
		agentId: params.agentId
	});
	const override = params.extraParamsOverride && Object.keys(params.extraParamsOverride).length > 0 ? sanitizeExtraParamsRecord(Object.fromEntries(Object.entries(params.extraParamsOverride).filter(([, value]) => value !== void 0))) : void 0;
	const merged = {
		...sanitizeExtraParamsRecord(resolvedExtraParams),
		...override
	};
	const resolvedCachedContent = resolveAliasedParamValue([resolvedExtraParams, override], "cached_content", "cachedContent");
	if (resolvedCachedContent !== void 0) {
		merged.cachedContent = resolvedCachedContent;
		delete merged.cached_content;
	}
	if (params.provider === "openrouter") canonicalizeOpenRouterResponseCacheParams(merged, [resolvedExtraParams, override]);
	const cfg = params.cfg;
	const cacheKey = cfg ? resolvePreparedExtraParamsCacheKey(params) : void 0;
	if (cacheKey) {
		const cached = preparedExtraParamsCache.get(cfg)?.get(cacheKey);
		if (cached) return cached;
	}
	const prepared = providerRuntimeDeps.prepareProviderExtraParams({
		provider: params.provider,
		config: params.cfg,
		workspaceDir: params.workspaceDir,
		runtimeHandle: params.providerRuntimeHandle,
		context: {
			config: params.cfg,
			agentDir: params.agentDir,
			workspaceDir: params.workspaceDir,
			provider: params.provider,
			modelId: params.modelId,
			extraParams: merged,
			thinkingLevel: params.thinkingLevel
		}
	}) ?? merged;
	const transportPatch = providerRuntimeDeps.resolveProviderExtraParamsForTransport({
		provider: params.provider,
		config: params.cfg,
		workspaceDir: params.workspaceDir,
		runtimeHandle: params.providerRuntimeHandle,
		context: {
			config: params.cfg,
			agentDir: params.agentDir,
			workspaceDir: params.workspaceDir,
			provider: params.provider,
			modelId: params.modelId,
			extraParams: prepared,
			thinkingLevel: params.thinkingLevel,
			model: params.model,
			transport: params.resolvedTransport ?? resolveSupportedTransport(prepared.transport)
		}
	})?.patch;
	const result = transportPatch ? {
		...prepared,
		...transportPatch
	} : prepared;
	if (cacheKey) {
		let bucket = preparedExtraParamsCache.get(cfg);
		if (!bucket) {
			bucket = /* @__PURE__ */ new Map();
			preparedExtraParamsCache.set(cfg, bucket);
		}
		bucket.set(cacheKey, result);
	}
	return result;
}
function sanitizeExtraParamsRecord(value) {
	if (!value) return;
	return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "__proto__" && key !== "prototype" && key !== "constructor"));
}
function shouldApplyDefaultOpenAIGptRuntimeParams(params) {
	if (params.provider !== "openai" && params.provider !== "openai-codex") return false;
	return /^gpt-5(?:[.-]|$)/i.test(params.modelId);
}
function applyDefaultOpenAIGptRuntimeParams(params, merged) {
	if (!shouldApplyDefaultOpenAIGptRuntimeParams(params)) return;
	if (!Object.hasOwn(merged, "parallel_tool_calls") && !Object.hasOwn(merged, "parallelToolCalls")) merged.parallel_tool_calls = true;
	if (!Object.hasOwn(merged, "text_verbosity") && !Object.hasOwn(merged, "textVerbosity")) merged.text_verbosity = "low";
}
function resolveAgentTransportOverride(params) {
	const globalSettings = params.settingsManager.getGlobalSettings();
	const projectSettings = params.settingsManager.getProjectSettings();
	if (hasExplicitTransportSetting(globalSettings) || hasExplicitTransportSetting(projectSettings)) return;
	return resolveSupportedTransport(params.effectiveExtraParams?.transport);
}
function resolveExplicitSettingsTransport(params) {
	const globalSettings = params.settingsManager.getGlobalSettings();
	const projectSettings = params.settingsManager.getProjectSettings();
	if (!hasExplicitTransportSetting(globalSettings) && !hasExplicitTransportSetting(projectSettings)) return;
	return resolveSupportedTransport(params.sessionTransport);
}
function createStreamFnWithExtraParams(baseStreamFn, extraParams, provider, model) {
	if (!extraParams || Object.keys(extraParams).length === 0) return;
	const streamParams = {};
	if (typeof extraParams.temperature === "number") streamParams.temperature = extraParams.temperature;
	if (typeof extraParams.maxTokens === "number") streamParams.maxTokens = extraParams.maxTokens;
	const transport = resolveSupportedTransport(extraParams.transport);
	if (transport) streamParams.transport = transport;
	else if (extraParams.transport != null) {
		const transportSummary = typeof extraParams.transport === "string" ? extraParams.transport : typeof extraParams.transport;
		log.warn(`ignoring invalid transport param: ${transportSummary}`);
	}
	const cachedContent = typeof extraParams.cachedContent === "string" ? extraParams.cachedContent : typeof extraParams.cached_content === "string" ? extraParams.cached_content : void 0;
	if (typeof cachedContent === "string" && cachedContent.trim()) streamParams.cachedContent = cachedContent.trim();
	const initialCacheRetention = resolveCacheRetention(extraParams, provider, typeof model?.api === "string" ? model.api : void 0, typeof model?.id === "string" ? model.id : void 0);
	if (Object.keys(streamParams).length > 0 || initialCacheRetention) {
		const debugParams = initialCacheRetention ? {
			...streamParams,
			cacheRetention: initialCacheRetention
		} : streamParams;
		log.debug(`creating streamFn wrapper with params: ${JSON.stringify(debugParams)}`);
	}
	const underlying = baseStreamFn ?? streamSimple;
	const wrappedStreamFn = (callModel, context, options) => {
		const cacheRetention = resolveCacheRetention(extraParams, provider, typeof callModel.api === "string" ? callModel.api : void 0, typeof callModel.id === "string" ? callModel.id : void 0);
		if (Object.keys(streamParams).length === 0 && !cacheRetention) return underlying(callModel, context, options);
		return underlying(callModel, context, {
			...streamParams,
			...cacheRetention ? { cacheRetention } : {},
			...options
		});
	};
	return wrappedStreamFn;
}
function resolveAliasedParamValue(sources, snakeCaseKey, camelCaseKey) {
	return resolveAliasedParamValueFromKeys(sources, [snakeCaseKey, camelCaseKey]);
}
function resolveAliasedParamValueFromKeys(sources, keys) {
	let resolved = void 0;
	let seen = false;
	for (const source of sources) {
		if (!source) continue;
		for (const key of keys) {
			if (!Object.hasOwn(source, key)) continue;
			resolved = source[key];
			seen = true;
			break;
		}
	}
	return seen ? resolved : void 0;
}
function applyCanonicalAliasedParamValue(params) {
	const resolved = resolveAliasedParamValueFromKeys(params.sources, params.keys);
	if (resolved === void 0) return;
	for (const key of params.keys) delete params.merged[key];
	params.merged[params.canonicalKey] = resolved;
}
function canonicalizeOpenRouterResponseCacheParams(merged, sources) {
	applyCanonicalAliasedParamValue({
		merged,
		sources,
		keys: ["responseCache", "response_cache"],
		canonicalKey: "responseCache"
	});
	applyCanonicalAliasedParamValue({
		merged,
		sources,
		keys: [
			"responseCacheTtlSeconds",
			"response_cache_ttl_seconds",
			"responseCacheTtl",
			"response_cache_ttl"
		],
		canonicalKey: "responseCacheTtlSeconds"
	});
	applyCanonicalAliasedParamValue({
		merged,
		sources,
		keys: ["responseCacheClear", "response_cache_clear"],
		canonicalKey: "responseCacheClear"
	});
}
function createParallelToolCallsWrapper(baseStreamFn, enabled) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		if (!supportsGptParallelToolCallsPayload(model.api)) return underlying(model, context, options);
		log.debug(`applying parallel_tool_calls=${enabled} for ${model.provider ?? "unknown"}/${model.id ?? "unknown"} api=${model.api}`);
		return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
			payloadObj.parallel_tool_calls = enabled;
		});
	};
}
function shouldStripOpenAICompletionsStore(model) {
	if (model.api !== "openai-completions") return false;
	const compat = model.compat && typeof model.compat === "object" ? model.compat : void 0;
	return !resolveProviderRequestPolicyConfig({
		provider: typeof model.provider === "string" ? model.provider : void 0,
		api: model.api,
		baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : void 0,
		compat,
		capability: "llm",
		transport: "stream"
	}).capabilities.usesKnownNativeOpenAIRoute;
}
function createOpenAICompletionsStoreCompatWrapper(baseStreamFn) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		if (!shouldStripOpenAICompletionsStore(model)) return underlying(model, context, options);
		return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
			delete payloadObj.store;
		});
	};
}
function sanitizeExtraBodyRecord(value) {
	return Object.fromEntries(Object.entries(sanitizeExtraParamsRecord(value) ?? {}).filter(([, entry]) => entry !== void 0));
}
function resolveExtraBodyParam(rawExtraBody) {
	if (rawExtraBody === void 0 || rawExtraBody === null) return;
	if (typeof rawExtraBody !== "object" || Array.isArray(rawExtraBody)) {
		const summary = typeof rawExtraBody === "string" ? rawExtraBody : typeof rawExtraBody;
		log.warn(`ignoring invalid extra_body param: ${summary}`);
		return;
	}
	const extraBody = sanitizeExtraBodyRecord(rawExtraBody);
	return Object.keys(extraBody).length > 0 ? extraBody : void 0;
}
function resolveChatTemplateKwargsParam(rawChatTemplateKwargs) {
	if (rawChatTemplateKwargs === void 0 || rawChatTemplateKwargs === null) return;
	if (typeof rawChatTemplateKwargs !== "object" || Array.isArray(rawChatTemplateKwargs)) {
		const summary = typeof rawChatTemplateKwargs === "string" ? rawChatTemplateKwargs : typeof rawChatTemplateKwargs;
		log.warn(`ignoring invalid chat_template_kwargs param: ${summary}`);
		return;
	}
	const chatTemplateKwargs = sanitizeExtraBodyRecord(rawChatTemplateKwargs);
	return Object.keys(chatTemplateKwargs).length > 0 ? chatTemplateKwargs : void 0;
}
function createOpenAICompletionsChatTemplateKwargsWrapper(params) {
	const underlying = params.baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		if (model.api !== "openai-completions") return underlying(model, context, options);
		return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
			const existing = payloadObj.chat_template_kwargs;
			if (existing && typeof existing === "object" && !Array.isArray(existing)) {
				payloadObj.chat_template_kwargs = {
					...existing,
					...params.configured
				};
				return;
			}
			payloadObj.chat_template_kwargs = params.configured;
		});
	};
}
function createOpenAICompletionsExtraBodyWrapper(baseStreamFn, extraBody) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		if (model.api !== "openai-completions") return underlying(model, context, options);
		return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
			const collisions = Object.keys(extraBody).filter((key) => Object.hasOwn(payloadObj, key));
			if (collisions.length > 0) log.warn(`extra_body overwriting request payload keys: ${collisions.join(", ")}`);
			Object.assign(payloadObj, extraBody);
		});
	};
}
function applyPrePluginStreamWrappers(ctx) {
	const wrappedStreamFn = createStreamFnWithExtraParams(ctx.agent.streamFn, ctx.effectiveExtraParams, ctx.provider, ctx.model);
	if (wrappedStreamFn) {
		log.debug(`applying extraParams to agent streamFn for ${ctx.provider}/${ctx.modelId}`);
		ctx.agent.streamFn = wrappedStreamFn;
	}
	if (shouldApplySiliconFlowThinkingOffCompat({
		provider: ctx.provider,
		modelId: ctx.modelId,
		thinkingLevel: ctx.thinkingLevel
	})) {
		log.debug(`normalizing thinking=off to thinking=null for SiliconFlow compatibility (${ctx.provider}/${ctx.modelId})`);
		ctx.agent.streamFn = createSiliconFlowThinkingWrapper(ctx.agent.streamFn);
	}
}
function applyPostPluginStreamWrappers(ctx) {
	ctx.agent.streamFn = createOpenRouterSystemCacheWrapper(ctx.agent.streamFn);
	ctx.agent.streamFn = createOpenAIStringContentWrapper(ctx.agent.streamFn);
	ctx.agent.streamFn = createOpenAICompletionsStrictMessageKeysWrapper(ctx.agent.streamFn);
	ctx.agent.streamFn = createOpenAICompletionsToolsCompatWrapper(ctx.agent.streamFn);
	if (!ctx.providerWrapperHandled) {
		ctx.agent.streamFn = createDeepSeekV4OpenAICompatibleThinkingWrapper({
			baseStreamFn: ctx.agent.streamFn,
			thinkingLevel: ctx.thinkingLevel,
			shouldPatchModel: isDeepSeekV4OpenAICompatibleModel
		});
		ctx.agent.streamFn = createGoogleThinkingPayloadWrapper(ctx.agent.streamFn, ctx.thinkingLevel);
		ctx.agent.streamFn = createOpenAIResponsesContextManagementWrapper(ctx.agent.streamFn, ctx.effectiveExtraParams);
	}
	ctx.agent.streamFn = createMinimaxThinkingDisabledWrapper(ctx.agent.streamFn);
	const configuredChatTemplateKwargs = resolveChatTemplateKwargsParam(resolveAliasedParamValue([ctx.effectiveExtraParams, ctx.override], "chat_template_kwargs", "chatTemplateKwargs"));
	if (configuredChatTemplateKwargs) ctx.agent.streamFn = createOpenAICompletionsChatTemplateKwargsWrapper({
		baseStreamFn: ctx.agent.streamFn,
		configured: configuredChatTemplateKwargs
	});
	const extraBody = resolveExtraBodyParam(resolveAliasedParamValue([ctx.effectiveExtraParams, ctx.override], "extra_body", "extraBody"));
	if (extraBody) ctx.agent.streamFn = createOpenAICompletionsExtraBodyWrapper(ctx.agent.streamFn, extraBody);
	ctx.agent.streamFn = createOpenAICompletionsStoreCompatWrapper(ctx.agent.streamFn);
	const rawParallelToolCalls = resolveAliasedParamValue([ctx.effectiveExtraParams, ctx.override], "parallel_tool_calls", "parallelToolCalls");
	if (rawParallelToolCalls === void 0) return;
	if (typeof rawParallelToolCalls === "boolean") {
		ctx.agent.streamFn = createParallelToolCallsWrapper(ctx.agent.streamFn, rawParallelToolCalls);
		return;
	}
	if (rawParallelToolCalls === null) {
		log.debug("parallel_tool_calls suppressed by null override, skipping injection");
		return;
	}
	const summary = typeof rawParallelToolCalls === "string" ? rawParallelToolCalls : typeof rawParallelToolCalls;
	log.warn(`ignoring invalid parallel_tool_calls param: ${summary}`);
}
function normalizeDeepSeekV4CandidateId(modelId) {
	if (typeof modelId !== "string") return;
	return modelId.trim().toLowerCase().split(":", 1)[0].split("/").pop();
}
function isDeepSeekV4OpenAICompatibleModel(model) {
	const normalizedModelId = normalizeDeepSeekV4CandidateId(model.id);
	return model.api === "openai-completions" && (normalizedModelId === "deepseek-v4-flash" || normalizedModelId === "deepseek-v4-pro");
}
/**
* Apply extra params (like temperature) to an agent's streamFn.
* Also applies verified provider-specific request wrappers, such as OpenRouter attribution.
*
* @internal Exported for testing
*/
function applyExtraParamsToAgent(agent, cfg, provider, modelId, extraParamsOverride, thinkingLevel, agentId, workspaceDir, model, agentDir, resolvedTransport, options) {
	const resolvedExtraParams = resolveExtraParams({
		cfg,
		provider,
		modelId,
		agentId
	});
	const override = extraParamsOverride && Object.keys(extraParamsOverride).length > 0 ? Object.fromEntries(Object.entries(extraParamsOverride).filter(([, value]) => value !== void 0)) : void 0;
	const effectiveExtraParams = options?.preparedExtraParams ?? resolvePreparedExtraParams({
		cfg,
		provider,
		modelId,
		extraParamsOverride,
		thinkingLevel,
		agentId,
		agentDir,
		workspaceDir,
		resolvedExtraParams,
		model,
		resolvedTransport
	});
	const wrapperContext = {
		agent,
		cfg,
		provider,
		modelId,
		agentDir,
		workspaceDir,
		thinkingLevel,
		model,
		effectiveExtraParams,
		resolvedExtraParams,
		override
	};
	const providerStreamBase = agent.streamFn;
	const pluginWrappedStreamFn = providerRuntimeDeps.wrapProviderStreamFn({
		provider,
		config: cfg,
		context: {
			config: cfg,
			agentDir,
			workspaceDir,
			provider,
			modelId,
			extraParams: effectiveExtraParams,
			thinkingLevel,
			model,
			streamFn: providerStreamBase
		}
	});
	agent.streamFn = pluginWrappedStreamFn ?? providerStreamBase;
	applyPrePluginStreamWrappers(wrapperContext);
	const providerWrapperHandled = pluginWrappedStreamFn !== void 0 && pluginWrappedStreamFn !== providerStreamBase;
	applyPostPluginStreamWrappers({
		...wrapperContext,
		providerWrapperHandled
	});
	return { effectiveExtraParams };
}
//#endregion
export { resolvePreparedExtraParams as a, resolveExtraParams as i, resolveAgentTransportOverride as n, isGooglePromptCacheEligible as o, resolveExplicitSettingsTransport as r, resolveCacheRetention as s, applyExtraParamsToAgent as t };

import { f as readStringValue, s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { i as resolveProviderRequestPolicy } from "./provider-attribution-DzSzEwzu.js";
import { l as resolveProviderRequestPolicyConfig } from "./provider-request-config-Bca1NoEF.js";
import { C as resolveOpenAIReasoningEffortForModel, a as applyOpenAIResponsesPayloadPolicy, i as createOpenAIResponsesTransportStreamFn, o as resolveOpenAIResponsesPayloadPolicy, s as flattenCompletionMessagesToStringContent } from "./openai-transport-stream-CIql9h7a.js";
import { t as log } from "./logger-Blf8M-xa.js";
import { t as applyAnthropicEphemeralCacheControlMarkers } from "./anthropic-payload-policy-CU2rs9H9.js";
import { g as streamWithPayloadPatch } from "./provider-model-shared-EoaoyeJq.js";
import { a as resolveCodexNativeSearchActivation, i as patchCodexNativeWebSearchPayload } from "./codex-native-web-search-core-BSMTk2YR.js";
import { O as isAnthropicModelRef } from "./provider-stream-shared-Cq45fRri.js";
import { streamSimple } from "@mariozechner/pi-ai";
//#region src/agents/openai-text-verbosity.ts
function normalizeOpenAITextVerbosity(value) {
	if (typeof value !== "string") return;
	const normalized = normalizeOptionalLowercaseString(value);
	if (normalized === "low" || normalized === "medium" || normalized === "high") return normalized;
}
function resolveOpenAITextVerbosity(extraParams) {
	const raw = extraParams?.textVerbosity ?? extraParams?.text_verbosity;
	const normalized = normalizeOpenAITextVerbosity(raw);
	if (raw !== void 0 && normalized === void 0) {
		const rawSummary = typeof raw === "string" ? raw : typeof raw;
		log.warn(`ignoring invalid OpenAI text verbosity param: ${rawSummary}`);
	}
	return normalized;
}
//#endregion
//#region src/agents/pi-embedded-runner/minimax-stream-wrappers.ts
const MINIMAX_FAST_MODEL_IDS = new Map([["MiniMax-M2.7", "MiniMax-M2.7-highspeed"]]);
function resolveMinimaxFastModelId(modelId) {
	if (typeof modelId !== "string") return;
	return MINIMAX_FAST_MODEL_IDS.get(modelId.trim());
}
function isMinimaxAnthropicMessagesModel(model) {
	return model.api === "anthropic-messages" && (model.provider === "minimax" || model.provider === "minimax-portal");
}
function createMinimaxFastModeWrapper(baseStreamFn, fastMode) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		if (!fastMode || model.api !== "anthropic-messages" || model.provider !== "minimax" && model.provider !== "minimax-portal") return underlying(model, context, options);
		const fastModelId = resolveMinimaxFastModelId(model.id);
		if (!fastModelId) return underlying(model, context, options);
		return underlying({
			...model,
			id: fastModelId
		}, context, options);
	};
}
/**
* MiniMax's Anthropic-compatible streaming endpoint returns reasoning_content
* in OpenAI-style delta chunks ({delta: {content: "", reasoning_content: "..."}})
* rather than the native Anthropic thinking block format. Pi-ai's Anthropic
* provider cannot process this format and leaks the reasoning text as visible
* content. Disable thinking in the outgoing payload so MiniMax does not produce
* reasoning_content deltas during streaming.
*/
function createMinimaxThinkingDisabledWrapper(baseStreamFn) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		if (!isMinimaxAnthropicMessagesModel(model)) return underlying(model, context, options);
		const originalOnPayload = options?.onPayload;
		return underlying(model, context, {
			...options,
			onPayload: (payload) => {
				if (payload && typeof payload === "object") {
					const payloadObj = payload;
					if (payloadObj.thinking === void 0) payloadObj.thinking = { type: "disabled" };
				}
				return originalOnPayload?.(payload, model);
			}
		});
	};
}
//#endregion
//#region src/agents/pi-embedded-runner/reasoning-effort-utils.ts
function mapThinkingLevelToReasoningEffort(thinkingLevel) {
	if (thinkingLevel === "off") return "none";
	if (thinkingLevel === "adaptive") return "medium";
	if (thinkingLevel === "max") return "xhigh";
	return thinkingLevel;
}
//#endregion
//#region src/agents/pi-embedded-runner/openai-stream-wrappers.ts
function resolveOpenAIRequestCapabilities(model) {
	const compat = model.compat && typeof model.compat === "object" ? model.compat : void 0;
	return resolveProviderRequestPolicyConfig({
		provider: readStringValue(model.provider),
		api: readStringValue(model.api),
		baseUrl: readStringValue(model.baseUrl),
		compat,
		capability: "llm",
		transport: "stream"
	}).capabilities;
}
function shouldApplyOpenAIAttributionHeaders(model) {
	const attributionProvider = resolveOpenAIRequestCapabilities(model).attributionProvider;
	return attributionProvider === "openai" || attributionProvider === "openai-codex" ? attributionProvider : void 0;
}
function shouldApplyOpenAIServiceTier(model) {
	return resolveOpenAIResponsesPayloadPolicy(model, { storeMode: "disable" }).allowsServiceTier;
}
function shouldApplyOpenAIReasoningCompatibility(model) {
	const api = readStringValue(model.api);
	const provider = readStringValue(model.provider);
	if (!api || !provider) return false;
	return resolveOpenAIRequestCapabilities(model).supportsOpenAIReasoningCompatPayload;
}
function shouldFlattenOpenAICompletionMessages(model) {
	const compat = model.compat && typeof model.compat === "object" ? model.compat : void 0;
	return model.api === "openai-completions" && compat?.requiresStringContent === true;
}
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function hasResponsesWebSearchTool(tools) {
	if (!Array.isArray(tools)) return false;
	return tools.some((tool) => {
		if (!isRecord(tool)) return false;
		if (tool.type === "web_search") return true;
		if (tool.type === "function" && tool.name === "web_search") return true;
		const fn = tool.function;
		return isRecord(fn) && fn.name === "web_search";
	});
}
function resolveOpenAIThinkingPayloadEffort(params) {
	const mapped = mapThinkingLevelToReasoningEffort(params.thinkingLevel);
	if (mapped !== "minimal" || !hasResponsesWebSearchTool(params.payloadObj.tools)) return mapped;
	return resolveOpenAIReasoningEffortForModel({
		model: params.model,
		effort: "low"
	}) ?? mapped;
}
function raiseMinimalReasoningForResponsesWebSearchPayload(params) {
	const reasoning = params.payloadObj.reasoning;
	if (!isRecord(reasoning) || reasoning.effort !== "minimal") return;
	if (!hasResponsesWebSearchTool(params.payloadObj.tools)) return;
	const nextEffort = resolveOpenAIReasoningEffortForModel({
		model: params.model,
		effort: "low"
	});
	if (nextEffort && nextEffort !== "minimal" && nextEffort !== "none") reasoning.effort = nextEffort;
}
function normalizeOpenAIServiceTier(value) {
	if (typeof value !== "string") return;
	const normalized = normalizeOptionalLowercaseString(value);
	if (normalized === "auto" || normalized === "default" || normalized === "flex" || normalized === "priority") return normalized;
}
function resolveOpenAIServiceTier(extraParams) {
	const raw = extraParams?.serviceTier ?? extraParams?.service_tier;
	const normalized = normalizeOpenAIServiceTier(raw);
	if (raw !== void 0 && normalized === void 0) {
		const rawSummary = typeof raw === "string" ? raw : typeof raw;
		log.warn(`ignoring invalid OpenAI service tier param: ${rawSummary}`);
	}
	return normalized;
}
function normalizeOpenAIFastMode(value) {
	if (typeof value === "boolean") return value;
	const normalized = normalizeOptionalLowercaseString(value);
	if (!normalized) return;
	if (normalized === "on" || normalized === "true" || normalized === "yes" || normalized === "1" || normalized === "fast") return true;
	if (normalized === "off" || normalized === "false" || normalized === "no" || normalized === "0" || normalized === "normal") return false;
}
function resolveOpenAIFastMode(extraParams) {
	const raw = extraParams?.fastMode ?? extraParams?.fast_mode;
	const normalized = normalizeOpenAIFastMode(raw);
	if (raw !== void 0 && normalized === void 0) {
		const rawSummary = typeof raw === "string" ? raw : typeof raw;
		log.warn(`ignoring invalid OpenAI fast mode param: ${rawSummary}`);
	}
	return normalized;
}
function applyOpenAIFastModePayloadOverrides(params) {
	if (params.payloadObj.service_tier === void 0 && shouldApplyOpenAIServiceTier(params.model)) params.payloadObj.service_tier = "priority";
}
function createOpenAIResponsesContextManagementWrapper(baseStreamFn, extraParams) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		const policy = resolveOpenAIResponsesPayloadPolicy(model, {
			extraParams,
			enablePromptCacheStripping: true,
			enableServerCompaction: true,
			storeMode: "provider-policy"
		});
		if (policy.explicitStore === void 0 && !policy.useServerCompaction && !policy.shouldStripStore && !policy.shouldStripPromptCache && !policy.shouldStripDisabledReasoningPayload) return underlying(model, context, options);
		const originalOnPayload = options?.onPayload;
		return underlying(model, context, {
			...options,
			onPayload: (payload) => {
				if (payload && typeof payload === "object") applyOpenAIResponsesPayloadPolicy(payload, policy);
				return originalOnPayload?.(payload, model);
			}
		});
	};
}
function createOpenAIReasoningCompatibilityWrapper(baseStreamFn) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		if (!shouldApplyOpenAIReasoningCompatibility(model)) return underlying(model, context, options);
		return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
			applyOpenAIResponsesPayloadPolicy(payloadObj, resolveOpenAIResponsesPayloadPolicy(model, { storeMode: "preserve" }));
		});
	};
}
function createOpenAIStringContentWrapper(baseStreamFn) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		if (!shouldFlattenOpenAICompletionMessages(model)) return underlying(model, context, options);
		return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
			if (!Array.isArray(payloadObj.messages)) return;
			payloadObj.messages = flattenCompletionMessagesToStringContent(payloadObj.messages);
		});
	};
}
function createOpenAIThinkingLevelWrapper(baseStreamFn, thinkingLevel) {
	const underlying = baseStreamFn ?? streamSimple;
	if (!thinkingLevel) return underlying;
	return (model, context, options) => {
		if (!shouldApplyOpenAIReasoningCompatibility(model)) {
			if (thinkingLevel === "off") return underlying(model, context, options);
			return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
				raiseMinimalReasoningForResponsesWebSearchPayload({
					model,
					payloadObj
				});
			});
		}
		return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
			const existingReasoning = payloadObj.reasoning;
			if (thinkingLevel === "off") {
				if (existingReasoning !== void 0) delete payloadObj.reasoning;
				return;
			}
			const reasoningEffort = resolveOpenAIThinkingPayloadEffort({
				model,
				payloadObj,
				thinkingLevel
			});
			if (existingReasoning === "none") {
				payloadObj.reasoning = { effort: reasoningEffort };
				return;
			}
			if (existingReasoning && typeof existingReasoning === "object" && !Array.isArray(existingReasoning)) {
				existingReasoning.effort = reasoningEffort;
				raiseMinimalReasoningForResponsesWebSearchPayload({
					model,
					payloadObj
				});
			}
		});
	};
}
function createOpenAIFastModeWrapper(baseStreamFn) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		if (model.api !== "openai-responses" && model.api !== "openai-codex-responses" && model.api !== "azure-openai-responses" || model.provider !== "openai" && model.provider !== "openai-codex") return underlying(model, context, options);
		const originalOnPayload = options?.onPayload;
		return underlying(model, context, {
			...options,
			onPayload: (payload) => {
				if (payload && typeof payload === "object") applyOpenAIFastModePayloadOverrides({
					payloadObj: payload,
					model
				});
				return originalOnPayload?.(payload, model);
			}
		});
	};
}
function createOpenAIServiceTierWrapper(baseStreamFn, serviceTier) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		if (!shouldApplyOpenAIServiceTier(model)) return underlying(model, context, options);
		return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
			if (payloadObj.service_tier === void 0) payloadObj.service_tier = serviceTier;
		});
	};
}
function createOpenAITextVerbosityWrapper(baseStreamFn, verbosity) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		if (model.api !== "openai-responses" && model.api !== "openai-codex-responses") return underlying(model, context, options);
		const shouldOverrideExistingVerbosity = model.api === "openai-codex-responses";
		const originalOnPayload = options?.onPayload;
		return underlying(model, context, {
			...options,
			onPayload: (payload) => {
				if (payload && typeof payload === "object") {
					const payloadObj = payload;
					const existingText = payloadObj.text && typeof payloadObj.text === "object" ? payloadObj.text : {};
					if (shouldOverrideExistingVerbosity || existingText.verbosity === void 0) payloadObj.text = {
						...existingText,
						verbosity
					};
				}
				return originalOnPayload?.(payload, model);
			}
		});
	};
}
function createCodexNativeWebSearchWrapper(baseStreamFn, params) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		const activation = resolveCodexNativeSearchActivation({
			config: params.config,
			modelProvider: readStringValue(model.provider),
			modelApi: readStringValue(model.api),
			agentDir: params.agentDir
		});
		if (activation.state !== "native_active") {
			if (activation.codexNativeEnabled) log.debug(`skipping Codex native web search (${activation.inactiveReason ?? "inactive"}) for ${model.provider ?? "unknown"}/${model.id ?? "unknown"}`);
			return underlying(model, context, options);
		}
		log.debug(`activating Codex native web search (${activation.codexMode}) for ${model.provider ?? "unknown"}/${model.id ?? "unknown"}`);
		const originalOnPayload = options?.onPayload;
		return underlying(model, context, {
			...options,
			onPayload: (payload) => {
				const result = patchCodexNativeWebSearchPayload({
					payload,
					config: params.config
				});
				if (result.status === "payload_not_object") log.debug("Skipping Codex native web search injection because provider payload is not an object");
				else if (result.status === "native_tool_already_present") log.debug("Codex native web search tool already present in provider payload");
				else if (result.status === "injected") log.debug("Injected Codex native web search tool into provider payload");
				return originalOnPayload?.(payload, model);
			}
		});
	};
}
function createOpenAIDefaultTransportWrapper(baseStreamFn) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		const typedOptions = options;
		return underlying(model, context, {
			...options,
			transport: options?.transport ?? "auto",
			openaiWsWarmup: typedOptions?.openaiWsWarmup ?? true
		});
	};
}
function createOpenAIAttributionHeadersWrapper(baseStreamFn, opts) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		const attributionProvider = shouldApplyOpenAIAttributionHeaders(model);
		if (!attributionProvider) return underlying(model, context, options);
		return (attributionProvider === "openai-codex" && (baseStreamFn === void 0 || baseStreamFn === streamSimple) ? opts?.codexNativeTransportStreamFn ?? createOpenAIResponsesTransportStreamFn() : underlying)(model, context, {
			...options,
			headers: resolveProviderRequestPolicyConfig({
				provider: attributionProvider,
				api: readStringValue(model.api),
				baseUrl: readStringValue(model.baseUrl),
				capability: "llm",
				transport: "stream",
				callerHeaders: options?.headers,
				precedence: "defaults-win"
			}).headers
		});
	};
}
//#endregion
//#region src/agents/pi-embedded-runner/proxy-stream-wrappers.ts
const KILOCODE_FEATURE_HEADER = "X-KILOCODE-FEATURE";
const KILOCODE_FEATURE_DEFAULT = "openclaw";
const KILOCODE_FEATURE_ENV_VAR = "KILOCODE_FEATURE";
function resolveKilocodeAppHeaders() {
	const feature = process.env[KILOCODE_FEATURE_ENV_VAR]?.trim() || KILOCODE_FEATURE_DEFAULT;
	return { [KILOCODE_FEATURE_HEADER]: feature };
}
function readExtraParam(extraParams, keys) {
	if (!extraParams) return;
	for (const key of keys) if (Object.hasOwn(extraParams, key)) return extraParams[key];
}
function resolveBooleanParam(value) {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return;
	const normalized = normalizeOptionalLowercaseString(value);
	if (!normalized) return;
	if ([
		"1",
		"true",
		"yes",
		"on",
		"enable",
		"enabled"
	].includes(normalized)) return true;
	if ([
		"0",
		"false",
		"no",
		"off",
		"disable",
		"disabled"
	].includes(normalized)) return false;
}
function resolveOpenRouterResponseCacheTtlSeconds(value) {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value.trim()) : NaN;
	if (!Number.isFinite(parsed)) return;
	return String(Math.max(1, Math.min(86400, Math.trunc(parsed))));
}
function shouldApplyOpenRouterResponseCacheHeaders(model) {
	const provider = readStringValue(model.provider);
	const endpointClass = resolveProviderRequestPolicy({
		provider,
		api: readStringValue(model.api),
		baseUrl: readStringValue(model.baseUrl),
		capability: "llm",
		transport: "stream"
	}).endpointClass;
	return endpointClass === "openrouter" || endpointClass === "default" && normalizeOptionalLowercaseString(provider) === "openrouter";
}
function resolveOpenRouterResponseCacheHeaders(model, extraParams) {
	if (!shouldApplyOpenRouterResponseCacheHeaders(model)) return;
	const configuredCache = resolveBooleanParam(readExtraParam(extraParams, ["responseCache", "response_cache"]));
	const clearCache = resolveBooleanParam(readExtraParam(extraParams, ["responseCacheClear", "response_cache_clear"]));
	const cacheEnabled = configuredCache ?? (clearCache ? true : void 0);
	if (cacheEnabled === void 0) return;
	const headers = { "X-OpenRouter-Cache": cacheEnabled ? "true" : "false" };
	if (!cacheEnabled) return headers;
	const ttl = resolveOpenRouterResponseCacheTtlSeconds(readExtraParam(extraParams, [
		"responseCacheTtlSeconds",
		"response_cache_ttl_seconds",
		"responseCacheTtl",
		"response_cache_ttl"
	]));
	if (ttl) headers["X-OpenRouter-Cache-TTL"] = ttl;
	if (clearCache) headers["X-OpenRouter-Cache-Clear"] = "true";
	return headers;
}
function normalizeProxyReasoningPayload(payload, thinkingLevel) {
	if (!payload || typeof payload !== "object") return;
	const payloadObj = payload;
	delete payloadObj.reasoning_effort;
	if (!thinkingLevel || thinkingLevel === "off") return;
	const existingReasoning = payloadObj.reasoning;
	if (existingReasoning && typeof existingReasoning === "object" && !Array.isArray(existingReasoning)) {
		const reasoningObj = existingReasoning;
		if (!("max_tokens" in reasoningObj) && !("effort" in reasoningObj)) reasoningObj.effort = mapThinkingLevelToReasoningEffort(thinkingLevel);
	} else if (!existingReasoning) payloadObj.reasoning = { effort: mapThinkingLevelToReasoningEffort(thinkingLevel) };
}
function createOpenRouterSystemCacheWrapper(baseStreamFn) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		const provider = readStringValue(model.provider);
		const modelId = readStringValue(model.id);
		const endpointClass = resolveProviderRequestPolicy({
			provider,
			api: readStringValue(model.api),
			baseUrl: readStringValue(model.baseUrl),
			capability: "llm",
			transport: "stream"
		}).endpointClass;
		if (!modelId || !isAnthropicModelRef(modelId) || !(endpointClass === "openrouter" || endpointClass === "default" && normalizeOptionalLowercaseString(provider) === "openrouter")) return underlying(model, context, options);
		return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
			applyAnthropicEphemeralCacheControlMarkers(payloadObj);
		});
	};
}
function createOpenRouterWrapper(baseStreamFn, thinkingLevel, extraParams) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		const providerHeaders = resolveOpenRouterResponseCacheHeaders(model, extraParams);
		const headers = resolveProviderRequestPolicyConfig({
			provider: readStringValue(model.provider) ?? "openrouter",
			api: readStringValue(model.api),
			baseUrl: readStringValue(model.baseUrl),
			capability: "llm",
			transport: "stream",
			callerHeaders: options?.headers,
			providerHeaders,
			precedence: "caller-wins"
		}).headers;
		return streamWithPayloadPatch(underlying, model, context, {
			...options,
			headers
		}, (payload) => {
			normalizeProxyReasoningPayload(payload, thinkingLevel);
		});
	};
}
function isProxyReasoningUnsupported(modelId) {
	const trimmed = normalizeOptionalLowercaseString(modelId);
	const slashIndex = trimmed?.indexOf("/") ?? -1;
	return slashIndex > 0 && trimmed?.slice(0, slashIndex) === "x-ai";
}
function createKilocodeWrapper(baseStreamFn, thinkingLevel) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		const headers = resolveProviderRequestPolicyConfig({
			provider: readStringValue(model.provider) ?? "kilocode",
			api: readStringValue(model.api),
			baseUrl: readStringValue(model.baseUrl),
			capability: "llm",
			transport: "stream",
			callerHeaders: options?.headers,
			providerHeaders: resolveKilocodeAppHeaders(),
			precedence: "defaults-win"
		}).headers;
		return streamWithPayloadPatch(underlying, model, context, {
			...options,
			headers
		}, (payload) => {
			normalizeProxyReasoningPayload(payload, thinkingLevel);
		});
	};
}
//#endregion
export { createMinimaxFastModeWrapper as _, createCodexNativeWebSearchWrapper as a, createOpenAIFastModeWrapper as c, createOpenAIServiceTierWrapper as d, createOpenAIStringContentWrapper as f, resolveOpenAIServiceTier as g, resolveOpenAIFastMode as h, isProxyReasoningUnsupported as i, createOpenAIReasoningCompatibilityWrapper as l, createOpenAIThinkingLevelWrapper as m, createOpenRouterSystemCacheWrapper as n, createOpenAIAttributionHeadersWrapper as o, createOpenAITextVerbosityWrapper as p, createOpenRouterWrapper as r, createOpenAIDefaultTransportWrapper as s, createKilocodeWrapper as t, createOpenAIResponsesContextManagementWrapper as u, createMinimaxThinkingDisabledWrapper as v, resolveOpenAITextVerbosity as y };

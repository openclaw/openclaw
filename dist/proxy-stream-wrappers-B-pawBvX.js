import { a as normalizeLowercaseStringOrEmpty, f as readStringValue, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { i as resolveProviderRequestPolicy } from "./provider-attribution-B2QMzk1g.js";
import { c as resolveProviderRequestPolicyConfig } from "./provider-request-config-DxK6PUHR.js";
import { D as emitModelTransportDebug, a as applyOpenAIResponsesPayloadPolicy, c as flattenCompletionMessagesToStringContent, i as createOpenAIResponsesTransportStreamFn, l as stripCompletionMessagesToRoleContent, o as resolveOpenAIResponsesPayloadPolicy, s as resolveOpenAIReasoningEffortForModel } from "./openai-transport-stream-Pgx5hpN7.js";
import { t as log } from "./logger-D2U-uUBZ.js";
import { a as resolveCodexNativeSearchActivation, i as patchCodexNativeWebSearchPayload } from "./codex-native-web-search-core-BA6gnwKx.js";
import { t as applyAnthropicEphemeralCacheControlMarkers } from "./anthropic-payload-policy-SPPqOSER.js";
import { i as streamWithPayloadPatch } from "./moonshot-thinking-stream-wrappers-D3FMTw1i.js";
import "./provider-stream-shared-jI_a6bxx.js";
import { streamSimple } from "@earendil-works/pi-ai";
//#region src/agents/pi-embedded-runner/anthropic-family-cache-semantics.ts
function isAnthropicModelRef(modelId) {
	return normalizeLowercaseStringOrEmpty(modelId).startsWith("anthropic/");
}
/** Matches Application Inference Profile ARNs across all AWS partitions with Bedrock. */
const BEDROCK_APP_INFERENCE_PROFILE_ARN_RE = /^arn:aws(-cn|-us-gov)?:bedrock:/;
function isAnthropicBedrockModel(modelId) {
	const normalized = normalizeLowercaseStringOrEmpty(modelId);
	if (normalized.includes("anthropic.claude") || normalized.includes("anthropic/claude")) return true;
	if (BEDROCK_APP_INFERENCE_PROFILE_ARN_RE.test(normalized) && normalized.includes(":application-inference-profile/")) return (normalized.split(":application-inference-profile/")[1] ?? "").includes("claude");
	return false;
}
function isAnthropicFamilyCacheTtlEligible(params) {
	const normalizedProvider = normalizeOptionalLowercaseString(params.provider);
	if (normalizedProvider === "anthropic" || normalizedProvider === "anthropic-vertex") return true;
	if (normalizedProvider === "amazon-bedrock") return isAnthropicBedrockModel(params.modelId);
	return params.modelApi === "anthropic-messages";
}
function resolveAnthropicCacheRetentionFamily(params) {
	const normalizedProvider = normalizeOptionalLowercaseString(params.provider);
	if (normalizedProvider === "anthropic" || normalizedProvider === "anthropic-vertex") return "anthropic-direct";
	if (normalizedProvider === "amazon-bedrock" && params.hasExplicitCacheConfig && typeof params.modelId === "string") {
		if (isAnthropicBedrockModel(params.modelId)) return "anthropic-bedrock";
		if (BEDROCK_APP_INFERENCE_PROFILE_ARN_RE.test(normalizeLowercaseStringOrEmpty(params.modelId)) && normalizeLowercaseStringOrEmpty(params.modelId).includes(":application-inference-profile/")) return "anthropic-bedrock";
	}
	if (normalizedProvider !== "amazon-bedrock" && params.hasExplicitCacheConfig && params.modelApi === "anthropic-messages") return "custom-anthropic-api";
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
/** @deprecated MiniMax provider-owned stream helper; do not use from third-party plugins. */
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
/** @deprecated MiniMax provider-owned stream helper; do not use from third-party plugins. */
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
//#region src/agents/openai-text-verbosity.ts
function normalizeOpenAITextVerbosity(value) {
	if (typeof value !== "string") return;
	const normalized = normalizeOptionalLowercaseString(value);
	if (normalized === "low" || normalized === "medium" || normalized === "high") return normalized;
}
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
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
//#region src/agents/pi-embedded-runner/reasoning-effort-utils.ts
function mapThinkingLevelToReasoningEffort(thinkingLevel) {
	if (thinkingLevel === "off") return "none";
	if (thinkingLevel === "adaptive") return "medium";
	if (thinkingLevel === "max") return "xhigh";
	return thinkingLevel;
}
//#endregion
//#region src/agents/pi-embedded-runner/openai-stream-wrappers.ts
function resolveOpenAITextVerbosityForModel(model, verbosity) {
	const api = normalizeOptionalLowercaseString(model.api);
	const provider = normalizeOptionalLowercaseString(model.provider);
	const id = normalizeOptionalLowercaseString(model.id);
	if (api === "openai-responses" && provider === "openai" && id === "chat-latest") return "medium";
	return verbosity;
}
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
function isCodeModeEnabled(config) {
	const tools = config?.tools;
	if (!tools || typeof tools !== "object") return false;
	const codeMode = tools.codeMode;
	if (codeMode === true) return true;
	return Boolean(codeMode && typeof codeMode === "object" && codeMode.enabled === true);
}
function readPayloadToolName(tool) {
	if (!tool || typeof tool !== "object") return;
	const record = tool;
	if (typeof record.name === "string") return record.name;
	return typeof record.function?.name === "string" ? record.function.name : void 0;
}
function isCodeModePayloadToolName(name) {
	return name === "exec" || name === "wait";
}
function filterCodeModeToolDeclarations(declarations) {
	if (!Array.isArray(declarations)) return;
	return declarations.filter((declaration) => isCodeModePayloadToolName(readPayloadToolName(declaration)));
}
function filterCodeModeGroupedToolDeclarations(tool) {
	if (!tool || typeof tool !== "object" || Array.isArray(tool)) return;
	const record = tool;
	const filteredGroups = {};
	for (const key of ["functionDeclarations", "function_declarations"]) {
		const filtered = filterCodeModeToolDeclarations(record[key]);
		if (filtered === void 0) continue;
		if (filtered.length > 0) filteredGroups[key] = filtered;
	}
	return Object.keys(filteredGroups).length > 0 ? filteredGroups : void 0;
}
function filterCodeModePayloadTools(payload) {
	if (!payload || typeof payload !== "object") return;
	const record = payload;
	if (!Array.isArray(record.tools)) return;
	record.tools = record.tools.flatMap((tool) => {
		if (isCodeModePayloadToolName(readPayloadToolName(tool))) return [tool];
		const grouped = filterCodeModeGroupedToolDeclarations(tool);
		return grouped ? [grouped] : [];
	});
}
function hasCodeModeVisibleTools(context) {
	if (!Array.isArray(context.tools)) return false;
	const names = new Set(context.tools.map(readPayloadToolName).filter(Boolean));
	return names.has("exec") && names.has("wait");
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
function shouldStripOpenAICompletionTools(model) {
	const compat = model.compat && typeof model.compat === "object" ? model.compat : void 0;
	return model.api === "openai-completions" && compat?.supportsTools === false;
}
function shouldStripOpenAICompletionMessageKeys(model) {
	const compat = model.compat && typeof model.compat === "object" ? model.compat : void 0;
	return model.api === "openai-completions" && compat?.strictMessageKeys === true;
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
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
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
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
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
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
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
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
function createOpenAIReasoningCompatibilityWrapper(baseStreamFn) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		if (!shouldApplyOpenAIReasoningCompatibility(model)) return underlying(model, context, options);
		return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
			applyOpenAIResponsesPayloadPolicy(payloadObj, resolveOpenAIResponsesPayloadPolicy(model, { storeMode: "preserve" }));
		});
	};
}
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
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
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
function createOpenAICompletionsStrictMessageKeysWrapper(baseStreamFn) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		if (!shouldStripOpenAICompletionMessageKeys(model)) return underlying(model, context, options);
		return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
			if (!Array.isArray(payloadObj.messages)) return;
			payloadObj.messages = stripCompletionMessagesToRoleContent(payloadObj.messages);
		});
	};
}
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
function createOpenAICompletionsToolsCompatWrapper(baseStreamFn) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		if (!shouldStripOpenAICompletionTools(model)) return underlying(model, context, options);
		return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
			delete payloadObj.tools;
			delete payloadObj.tool_choice;
			delete payloadObj.parallel_tool_calls;
		});
	};
}
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
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
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
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
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
function createOpenAIServiceTierWrapper(baseStreamFn, serviceTier) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		if (!shouldApplyOpenAIServiceTier(model)) return underlying(model, context, options);
		return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
			if (payloadObj.service_tier === void 0) payloadObj.service_tier = serviceTier;
		});
	};
}
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
function createOpenAITextVerbosityWrapper(baseStreamFn, verbosity) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		if (model.api !== "openai-responses" && model.api !== "openai-codex-responses") return underlying(model, context, options);
		const resolvedVerbosity = resolveOpenAITextVerbosityForModel(model, verbosity);
		const shouldOverrideExistingVerbosity = model.api === "openai-codex-responses" || resolvedVerbosity !== verbosity;
		const originalOnPayload = options?.onPayload;
		return underlying(model, context, {
			...options,
			onPayload: (payload) => {
				if (payload && typeof payload === "object") {
					const payloadObj = payload;
					const existingText = payloadObj.text && typeof payloadObj.text === "object" ? payloadObj.text : {};
					if (shouldOverrideExistingVerbosity || existingText.verbosity === void 0) payloadObj.text = {
						...existingText,
						verbosity: resolvedVerbosity
					};
				}
				return originalOnPayload?.(payload, model);
			}
		});
	};
}
/** @deprecated OpenAI Codex provider-owned stream helper; do not use from third-party plugins. */
function createCodexNativeWebSearchWrapper(baseStreamFn, params) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		if ((params.codeModeToolSurfaceEnabled === true || isCodeModeEnabled(params.config)) && hasCodeModeVisibleTools(context)) {
			emitModelTransportDebug(log, `skipping Codex native web search because code mode owns the model tool surface for ${model.provider ?? "unknown"}/${model.id ?? "unknown"}`);
			const originalOnPayload = options?.onPayload;
			return underlying(model, context, {
				...options,
				openclawCodeModeToolSurface: true,
				onPayload: (payload) => {
					filterCodeModePayloadTools(payload);
					const nextPayload = originalOnPayload?.(payload, model);
					if (nextPayload !== void 0) {
						filterCodeModePayloadTools(nextPayload);
						return nextPayload;
					}
					filterCodeModePayloadTools(payload);
				}
			});
		}
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
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
function createOpenAIDefaultTransportWrapper(baseStreamFn) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		return underlying(model, context, {
			...options,
			transport: options?.transport ?? "auto"
		});
	};
}
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
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
/** @deprecated OpenRouter provider-owned stream helper; do not use from third-party plugins. */
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
/** @deprecated OpenRouter provider-owned stream helper; do not use from third-party plugins. */
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
/** @deprecated Proxy provider-owned stream helper; do not use from third-party plugins. */
function isProxyReasoningUnsupported(modelId) {
	const trimmed = normalizeOptionalLowercaseString(modelId);
	const slashIndex = trimmed?.indexOf("/") ?? -1;
	return slashIndex > 0 && trimmed?.slice(0, slashIndex) === "x-ai";
}
/** @deprecated Kilocode provider-owned stream helper; do not use from third-party plugins. */
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
export { isAnthropicModelRef as C, isAnthropicFamilyCacheTtlEligible as S, resolveOpenAIFastMode as _, createCodexNativeWebSearchWrapper as a, createMinimaxFastModeWrapper as b, createOpenAICompletionsToolsCompatWrapper as c, createOpenAIReasoningCompatibilityWrapper as d, createOpenAIResponsesContextManagementWrapper as f, createOpenAIThinkingLevelWrapper as g, createOpenAITextVerbosityWrapper as h, isProxyReasoningUnsupported as i, createOpenAIDefaultTransportWrapper as l, createOpenAIStringContentWrapper as m, createOpenRouterSystemCacheWrapper as n, createOpenAIAttributionHeadersWrapper as o, createOpenAIServiceTierWrapper as p, createOpenRouterWrapper as r, createOpenAICompletionsStrictMessageKeysWrapper as s, createKilocodeWrapper as t, createOpenAIFastModeWrapper as u, resolveOpenAIServiceTier as v, resolveAnthropicCacheRetentionFamily as w, createMinimaxThinkingDisabledWrapper as x, resolveOpenAITextVerbosity as y };

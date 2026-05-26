import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import "./anthropic-payload-policy-BdSt2Wgn.js";
import { i as streamWithPayloadPatch } from "./moonshot-thinking-stream-wrappers-DY0RTUKY.js";
import { streamSimple } from "@earendil-works/pi-ai";
//#region src/agents/pi-embedded-runner/zai-stream-wrappers.ts
/**
* Inject `tool_stream=true` so tool-call deltas stream in real time.
* Providers can disable this by setting `params.tool_stream=false`.
*
* @deprecated Provider-owned stream helper; do not use from third-party plugins.
*/
function createToolStreamWrapper(baseStreamFn, enabled) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		if (!enabled) return underlying(model, context, options);
		return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
			payloadObj.tool_stream = true;
		});
	};
}
/** @deprecated Z.ai provider-owned stream helper; do not use from third-party plugins. */
const createZaiToolStreamWrapper = createToolStreamWrapper;
//#endregion
//#region src/plugin-sdk/provider-stream-shared.ts
function composeProviderStreamWrappers(baseStreamFn, ...wrappers) {
	return wrappers.reduce((streamFn, wrapper) => wrapper ? wrapper(streamFn) : streamFn, baseStreamFn);
}
/** @deprecated Bundled provider stream helper; do not use from third-party plugins. */
function defaultToolStreamExtraParams(extraParams) {
	if (extraParams?.tool_stream !== void 0) return extraParams;
	return {
		...extraParams,
		tool_stream: true
	};
}
function createPayloadPatchStreamWrapper(baseStreamFn, patchPayload, wrapperOptions) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		if (wrapperOptions?.shouldPatch && !wrapperOptions.shouldPatch({
			model,
			context,
			options
		})) return underlying(model, context, options);
		return streamWithPayloadPatch(underlying, model, context, options, (payload) => patchPayload({
			payload,
			model,
			context,
			options
		}));
	};
}
function isAnthropicThinkingEnabled(payload) {
	const thinking = payload.thinking;
	if (!thinking || typeof thinking !== "object") return false;
	return thinking.type !== "disabled";
}
function assistantMessageHasAnthropicToolUse(message) {
	if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
	const content = message.content;
	if (!Array.isArray(content)) return false;
	return content.some((block) => block && typeof block === "object" && (block.type === "tool_use" || block.type === "toolCall"));
}
function stripTrailingAssistantPrefillMessages(payload) {
	if (!Array.isArray(payload.messages)) return 0;
	let stripped = 0;
	while (payload.messages.length > 0) {
		const finalMessage = payload.messages[payload.messages.length - 1];
		if (!finalMessage || typeof finalMessage !== "object") break;
		const message = finalMessage;
		if (message.role !== "assistant" || assistantMessageHasAnthropicToolUse(message)) break;
		payload.messages.pop();
		stripped += 1;
	}
	return stripped;
}
/** @deprecated Anthropic-family provider stream helper; do not use from third-party plugins. */
function stripTrailingAnthropicAssistantPrefillWhenThinking(payload) {
	if (!isAnthropicThinkingEnabled(payload)) return 0;
	return stripTrailingAssistantPrefillMessages(payload);
}
/** @deprecated Anthropic-family provider stream helper; do not use from third-party plugins. */
function createAnthropicThinkingPrefillPayloadWrapper(baseStreamFn, onStripped, wrapperOptions) {
	return createPayloadPatchStreamWrapper(baseStreamFn, ({ payload }) => {
		const stripped = stripTrailingAnthropicAssistantPrefillWhenThinking(payload);
		if (stripped > 0) onStripped?.(stripped);
	}, wrapperOptions);
}
/** @deprecated OpenAI-compatible provider stream helper; do not use from third-party plugins. */
function isOpenAICompatibleThinkingEnabled(params) {
	const options = params.options ?? {};
	const raw = options.reasoningEffort ?? options.reasoning ?? params.thinkingLevel ?? "high";
	if (typeof raw !== "string") return true;
	const normalized = raw.trim().toLowerCase();
	return normalized !== "off" && normalized !== "none";
}
function isDisabledDeepSeekV4ThinkingLevel(thinkingLevel) {
	const normalized = typeof thinkingLevel === "string" ? thinkingLevel.toLowerCase() : "";
	return normalized === "off" || normalized === "none";
}
function resolveDeepSeekV4ReasoningEffort(thinkingLevel) {
	return thinkingLevel === "xhigh" || thinkingLevel === "max" ? "max" : "high";
}
function stripDeepSeekV4ReasoningContent(payload) {
	if (!Array.isArray(payload.messages)) return;
	for (const message of payload.messages) {
		if (!message || typeof message !== "object") continue;
		delete message.reasoning_content;
	}
}
function ensureDeepSeekV4AssistantReasoningContent(payload) {
	if (!Array.isArray(payload.messages)) return;
	for (const message of payload.messages) {
		if (!message || typeof message !== "object") continue;
		const record = message;
		if (record.role !== "assistant") continue;
		if (!("reasoning_content" in record)) record.reasoning_content = "";
	}
}
/** @deprecated DeepSeek provider stream helper; do not use from third-party plugins. */
function createDeepSeekV4OpenAICompatibleThinkingWrapper(params) {
	if (!params.baseStreamFn) return;
	const underlying = params.baseStreamFn;
	const resolveReasoningEffort = params.resolveReasoningEffort ?? resolveDeepSeekV4ReasoningEffort;
	return (model, context, options) => {
		if (!params.shouldPatchModel(model)) return underlying(model, context, options);
		return streamWithPayloadPatch(underlying, model, context, options, (payload) => {
			if (isDisabledDeepSeekV4ThinkingLevel(params.thinkingLevel)) {
				payload.thinking = { type: "disabled" };
				delete payload.reasoning_effort;
				delete payload.reasoning;
				stripDeepSeekV4ReasoningContent(payload);
				return;
			}
			payload.thinking = { type: "enabled" };
			payload.reasoning_effort = resolveReasoningEffort(params.thinkingLevel);
			ensureDeepSeekV4AssistantReasoningContent(payload);
		});
	};
}
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
function isGoogleThinkingRequiredModel(modelId) {
	return normalizeLowercaseStringOrEmpty(modelId).includes("gemini-2.5-pro");
}
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
function isGoogleGemini25ThinkingBudgetModel(modelId) {
	return /(?:^|\/)gemini-2\.5-/.test(normalizeLowercaseStringOrEmpty(modelId));
}
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
function isGoogleGemini3ProModel(modelId) {
	const normalized = normalizeLowercaseStringOrEmpty(modelId);
	return /(?:^|\/)gemini-(?:3(?:\.\d+)?-pro|pro-latest)(?:-|$)/.test(normalized);
}
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
function isGoogleGemini3FlashModel(modelId) {
	const normalized = normalizeLowercaseStringOrEmpty(modelId);
	return /(?:^|\/)gemini-(?:3(?:\.\d+)?-flash|flash(?:-lite)?-latest)(?:-|$)/.test(normalized);
}
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
function isGoogleGemini3ThinkingLevelModel(modelId) {
	return isGoogleGemini3ProModel(modelId) || isGoogleGemini3FlashModel(modelId);
}
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
function resolveGoogleGemini3ThinkingLevel(params) {
	if (typeof params.modelId !== "string") return;
	if (isGoogleGemini3ProModel(params.modelId)) {
		switch (params.thinkingLevel) {
			case "off":
			case "minimal":
			case "low": return "LOW";
			case "medium":
			case "high":
			case "max":
			case "xhigh": return "HIGH";
			case "adaptive": return;
			case void 0: break;
		}
		if (typeof params.thinkingBudget === "number") {
			if (params.thinkingBudget < 0) return;
			return params.thinkingBudget <= 2048 ? "LOW" : "HIGH";
		}
		return;
	}
	if (!isGoogleGemini3FlashModel(params.modelId)) return;
	switch (params.thinkingLevel) {
		case "off":
		case "minimal": return "MINIMAL";
		case "low": return "LOW";
		case "medium": return "MEDIUM";
		case "high":
		case "max":
		case "xhigh": return "HIGH";
		case "adaptive": return;
		case void 0: break;
	}
	if (typeof params.thinkingBudget !== "number") return;
	if (params.thinkingBudget < 0) return;
	if (params.thinkingBudget <= 0) return "MINIMAL";
	if (params.thinkingBudget <= 2048) return "LOW";
	if (params.thinkingBudget <= 8192) return "MEDIUM";
	return "HIGH";
}
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
function stripInvalidGoogleThinkingBudget(params) {
	if (params.thinkingConfig.thinkingBudget !== 0 || typeof params.modelId !== "string" || !isGoogleThinkingRequiredModel(params.modelId)) return false;
	delete params.thinkingConfig.thinkingBudget;
	return true;
}
function isGemma4Model(modelId) {
	return normalizeLowercaseStringOrEmpty(modelId).startsWith("gemma-4");
}
function mapThinkLevelToGemma4ThinkingLevel(thinkingLevel) {
	switch (thinkingLevel) {
		case "off": return;
		case "minimal":
		case "low": return "MINIMAL";
		case "medium":
		case "adaptive":
		case "high":
		case "max":
		case "xhigh": return "HIGH";
		default: return;
	}
}
function normalizeGemma4ThinkingLevel(value) {
	if (typeof value !== "string") return;
	switch (value.trim().toUpperCase()) {
		case "MINIMAL":
		case "LOW": return "MINIMAL";
		case "MEDIUM":
		case "HIGH": return "HIGH";
		default: return;
	}
}
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
function sanitizeGoogleThinkingPayload(params) {
	if (!params.payload || typeof params.payload !== "object") return;
	const payloadObj = params.payload;
	sanitizeGoogleThinkingConfigContainer({
		container: payloadObj.config,
		modelId: params.modelId,
		thinkingLevel: params.thinkingLevel
	});
	sanitizeGoogleThinkingConfigContainer({
		container: payloadObj.generationConfig,
		modelId: params.modelId,
		thinkingLevel: params.thinkingLevel
	});
}
function sanitizeGoogleThinkingConfigContainer(params) {
	if (!params.container || typeof params.container !== "object") return;
	const configObj = params.container;
	const thinkingConfig = configObj.thinkingConfig;
	if (!thinkingConfig || typeof thinkingConfig !== "object") return;
	const thinkingConfigObj = thinkingConfig;
	if (typeof params.modelId === "string" && isGemma4Model(params.modelId)) {
		const normalizedThinkingLevel = normalizeGemma4ThinkingLevel(thinkingConfigObj.thinkingLevel);
		const explicitMappedLevel = mapThinkLevelToGemma4ThinkingLevel(params.thinkingLevel);
		const disabledViaBudget = typeof thinkingConfigObj.thinkingBudget === "number" && thinkingConfigObj.thinkingBudget <= 0;
		const hadThinkingBudget = thinkingConfigObj.thinkingBudget !== void 0;
		delete thinkingConfigObj.thinkingBudget;
		if (params.thinkingLevel === "off" || disabledViaBudget && explicitMappedLevel === void 0 && !normalizedThinkingLevel) {
			delete thinkingConfigObj.thinkingLevel;
			if (Object.keys(thinkingConfigObj).length === 0) delete configObj.thinkingConfig;
			return;
		}
		const mappedLevel = explicitMappedLevel ?? normalizedThinkingLevel ?? (hadThinkingBudget ? "MINIMAL" : void 0);
		if (mappedLevel) thinkingConfigObj.thinkingLevel = mappedLevel;
		return;
	}
	const thinkingBudget = thinkingConfigObj.thinkingBudget;
	if (params.thinkingLevel === "adaptive" && typeof params.modelId === "string" && isGoogleGemini25ThinkingBudgetModel(params.modelId)) {
		delete thinkingConfigObj.thinkingLevel;
		thinkingConfigObj.thinkingBudget = -1;
		return;
	}
	if (params.thinkingLevel === "adaptive" && typeof params.modelId === "string" && isGoogleGemini3ThinkingLevelModel(params.modelId)) {
		delete thinkingConfigObj.thinkingBudget;
		delete thinkingConfigObj.thinkingLevel;
		if (Object.keys(thinkingConfigObj).length === 0) delete configObj.thinkingConfig;
		return;
	}
	if (typeof params.modelId === "string" && isGoogleGemini3ThinkingLevelModel(params.modelId)) {
		const mappedLevel = resolveGoogleGemini3ThinkingLevel({
			modelId: params.modelId,
			thinkingLevel: params.thinkingLevel,
			thinkingBudget: typeof thinkingBudget === "number" ? thinkingBudget : void 0
		});
		delete thinkingConfigObj.thinkingBudget;
		if (mappedLevel) thinkingConfigObj.thinkingLevel = mappedLevel;
		if (Object.keys(thinkingConfigObj).length === 0) delete configObj.thinkingConfig;
		return;
	}
	if (stripInvalidGoogleThinkingBudget({
		thinkingConfig: thinkingConfigObj,
		modelId: params.modelId
	})) {
		if (Object.keys(thinkingConfigObj).length === 0) delete configObj.thinkingConfig;
		return;
	}
	if (typeof thinkingBudget !== "number" || thinkingBudget >= 0) return;
	delete thinkingConfigObj.thinkingBudget;
	if (Object.keys(thinkingConfigObj).length === 0) delete configObj.thinkingConfig;
}
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
function createGoogleThinkingPayloadWrapper(baseStreamFn, thinkingLevel) {
	return createPayloadPatchStreamWrapper(baseStreamFn, ({ payload, model }) => {
		if (model.api === "google-generative-ai") sanitizeGoogleThinkingPayload({
			payload,
			modelId: model.id,
			thinkingLevel
		});
	});
}
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
function createGoogleThinkingStreamWrapper(ctx) {
	return createGoogleThinkingPayloadWrapper(ctx.streamFn, ctx.thinkingLevel);
}
//#endregion
export { stripTrailingAnthropicAssistantPrefillWhenThinking as _, createGoogleThinkingStreamWrapper as a, isGoogleGemini25ThinkingBudgetModel as c, isGoogleGemini3ThinkingLevelModel as d, isGoogleThinkingRequiredModel as f, stripInvalidGoogleThinkingBudget as g, sanitizeGoogleThinkingPayload as h, createGoogleThinkingPayloadWrapper as i, isGoogleGemini3FlashModel as l, resolveGoogleGemini3ThinkingLevel as m, createAnthropicThinkingPrefillPayloadWrapper as n, createPayloadPatchStreamWrapper as o, isOpenAICompatibleThinkingEnabled as p, createDeepSeekV4OpenAICompatibleThinkingWrapper as r, defaultToolStreamExtraParams as s, composeProviderStreamWrappers as t, isGoogleGemini3ProModel as u, createToolStreamWrapper as v, createZaiToolStreamWrapper as y };

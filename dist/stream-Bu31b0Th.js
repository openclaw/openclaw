import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { o as createPayloadPatchStreamWrapper, r as createDeepSeekV4OpenAICompatibleThinkingWrapper } from "./provider-stream-shared-jI_a6bxx.js";
import "./runtime-env-BtvWnLRh.js";
import { o as OPENROUTER_THINKING_STREAM_HOOKS } from "./provider-stream-B32dNOmb.js";
import "./provider-stream-family-CGsj5YYd.js";
import { i as normalizeOpenRouterBaseUrl, r as isOpenRouterProxyReasoningUnsupportedModel, t as OPENROUTER_BASE_URL } from "./provider-catalog-Dya4CIwt.js";
import { t as isOpenRouterDeepSeekV4ModelId } from "./models-DN48-hmx.js";
//#region extensions/openrouter/stream.ts
const log = createSubsystemLogger("openrouter-stream");
function readString(value) {
	return typeof value === "string" ? value.trim() : void 0;
}
function isOpenRouterAnthropicModelId(modelId) {
	const normalized = readString(modelId)?.toLowerCase();
	return normalized?.startsWith("anthropic/") === true || normalized?.startsWith("openrouter/anthropic/") === true;
}
function isVerifiedOpenRouterRoute(model) {
	const provider = readString(model.provider)?.toLowerCase();
	const baseUrl = readString(model.baseUrl);
	if (baseUrl) return normalizeOpenRouterBaseUrl(baseUrl) === OPENROUTER_BASE_URL;
	return provider === "openrouter";
}
function shouldPatchAnthropicOpenRouterPayload(model) {
	const api = readString(model.api);
	return (api === void 0 || api === "openai-completions") && isOpenRouterAnthropicModelId(model.id) && isVerifiedOpenRouterRoute(model);
}
function shouldPatchDeepSeekV4OpenRouterPayload(model) {
	const api = readString(model.api);
	return (api === void 0 || api === "openai-completions") && isOpenRouterDeepSeekV4ModelId(model.id) && isVerifiedOpenRouterRoute(model);
}
function shouldPatchOpenRouterRoutingPayload(model) {
	const api = readString(model.api);
	return (api === void 0 || api === "openai-completions") && isVerifiedOpenRouterRoute(model);
}
function assistantMessageHasOpenAIToolCalls(message) {
	return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}
function isAnthropicToolCallContentBlock(value) {
	return value !== null && typeof value === "object" && (value.type === "tool_use" || value.type === "toolCall");
}
function assistantMessageHasAnthropicToolUse(message) {
	const content = message.content;
	return Array.isArray(content) && content.some(isAnthropicToolCallContentBlock);
}
function shouldStripOpenRouterTrailingMessage(value) {
	if (!value || typeof value !== "object") return false;
	const message = value;
	return message.role === "assistant" && !assistantMessageHasOpenAIToolCalls(message) && !assistantMessageHasAnthropicToolUse(message);
}
function stripTrailingOpenRouterAssistantPrefillMessages(payload) {
	const messages = payload.messages;
	if (!Array.isArray(messages)) return 0;
	let keep = messages.length;
	while (keep > 0 && shouldStripOpenRouterTrailingMessage(messages[keep - 1])) keep -= 1;
	if (keep === messages.length) return 0;
	const stripped = messages.length - keep;
	messages.splice(keep);
	return stripped;
}
function resolveOpenRouterDeepSeekV4ReasoningEffort(thinkingLevel) {
	switch (thinkingLevel) {
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh": return thinkingLevel;
		case "max": return "xhigh";
		case "adaptive": return "medium";
		case "off":
		case void 0: return "high";
	}
	return "high";
}
function isEnabledReasoningValue(value) {
	if (value === void 0 || value === null || value === false) return false;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		return normalized !== "" && normalized !== "off" && normalized !== "none";
	}
	return true;
}
function isOpenRouterReasoningPayloadEnabled(payload) {
	return isEnabledReasoningValue(payload.reasoning) || isEnabledReasoningValue(payload.reasoning_effort);
}
function injectOpenRouterRouting(baseStreamFn, providerRouting) {
	if (!providerRouting) return baseStreamFn;
	const routedStreamFn = (model, context, options) => (baseStreamFn ?? ((nextModel) => {
		throw new Error(`OpenRouter routing wrapper requires an underlying streamFn for ${nextModel.id}.`);
	}))({
		...model,
		compat: {
			...model.compat,
			openRouterRouting: providerRouting
		}
	}, context, options);
	return createPayloadPatchStreamWrapper(routedStreamFn, ({ payload }) => {
		if (payload.provider === void 0) payload.provider = providerRouting;
	}, { shouldPatch: ({ model }) => shouldPatchOpenRouterRoutingPayload(model) });
}
function createOpenRouterAnthropicPrefillWrapper(baseStreamFn) {
	return createPayloadPatchStreamWrapper(baseStreamFn, ({ payload }) => {
		if (!isOpenRouterReasoningPayloadEnabled(payload)) return;
		const stripped = stripTrailingOpenRouterAssistantPrefillMessages(payload);
		if (stripped > 0) log.warn(`removed ${stripped} trailing assistant prefill message${stripped === 1 ? "" : "s"} because OpenRouter-routed Anthropic reasoning requires conversations to end with a user turn`);
	}, { shouldPatch: ({ model }) => shouldPatchAnthropicOpenRouterPayload(model) });
}
function createOpenRouterDeepSeekV4ThinkingWrapper(baseStreamFn, thinkingLevel) {
	return createDeepSeekV4OpenAICompatibleThinkingWrapper({
		baseStreamFn,
		thinkingLevel,
		shouldPatchModel: shouldPatchDeepSeekV4OpenRouterPayload,
		resolveReasoningEffort: resolveOpenRouterDeepSeekV4ReasoningEffort,
		shouldBackfillAssistantReasoningContent: (message) => !assistantMessageHasOpenAIToolCalls(message)
	});
}
function wrapOpenRouterProviderStream(ctx) {
	const providerRouting = ctx.extraParams?.provider != null && typeof ctx.extraParams.provider === "object" ? ctx.extraParams.provider : void 0;
	const routedStreamFn = providerRouting ? injectOpenRouterRouting(ctx.streamFn, providerRouting) : ctx.streamFn;
	const wrapStreamFn = OPENROUTER_THINKING_STREAM_HOOKS.wrapStreamFn ?? void 0;
	if (!wrapStreamFn) return createOpenRouterAnthropicPrefillWrapper(createOpenRouterDeepSeekV4ThinkingWrapper(routedStreamFn, ctx.thinkingLevel));
	return createOpenRouterAnthropicPrefillWrapper(createOpenRouterDeepSeekV4ThinkingWrapper(wrapStreamFn({
		...ctx,
		streamFn: routedStreamFn,
		thinkingLevel: isOpenRouterProxyReasoningUnsupportedModel(ctx.modelId) ? void 0 : ctx.thinkingLevel
	}) ?? void 0, ctx.thinkingLevel));
}
//#endregion
export { wrapOpenRouterProviderStream as t };

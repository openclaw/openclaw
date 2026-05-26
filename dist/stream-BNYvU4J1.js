import { t as createSubsystemLogger } from "./subsystem-DLRoKDlF.js";
import { o as createPayloadPatchStreamWrapper, r as createDeepSeekV4OpenAICompatibleThinkingWrapper } from "./provider-stream-shared-BMzmRA_f.js";
import "./runtime-env-AKjXcC53.js";
import { o as OPENROUTER_THINKING_STREAM_HOOKS } from "./provider-stream-Cx3vdp_v.js";
import "./provider-stream-family-Bt76y7tu.js";
import { i as normalizeOpenRouterBaseUrl, r as isOpenRouterProxyReasoningUnsupportedModel, t as OPENROUTER_BASE_URL } from "./provider-catalog-tLFRKrNL.js";
import { t as isOpenRouterDeepSeekV4ModelId } from "./models-CUxKVmYG.js";
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
function injectOpenRouterRouting(baseStreamFn, providerRouting) {
	if (!providerRouting) return baseStreamFn;
	return (model, context, options) => (baseStreamFn ?? ((nextModel) => {
		throw new Error(`OpenRouter routing wrapper requires an underlying streamFn for ${nextModel.id}.`);
	}))({
		...model,
		compat: {
			...model.compat,
			openRouterRouting: providerRouting
		}
	}, context, options);
}
function createOpenRouterAnthropicPrefillWrapper(baseStreamFn) {
	return createPayloadPatchStreamWrapper(baseStreamFn, ({ payload }) => {
		if (!isOpenRouterReasoningPayloadEnabled(payload)) return;
		const stripped = stripTrailingAssistantPrefillMessages(payload);
		if (stripped > 0) log.warn(`removed ${stripped} trailing assistant prefill message${stripped === 1 ? "" : "s"} because OpenRouter-routed Anthropic reasoning requires conversations to end with a user turn`);
	}, { shouldPatch: ({ model }) => shouldPatchAnthropicOpenRouterPayload(model) });
}
function createOpenRouterDeepSeekV4ThinkingWrapper(baseStreamFn, thinkingLevel) {
	return createDeepSeekV4OpenAICompatibleThinkingWrapper({
		baseStreamFn,
		thinkingLevel,
		shouldPatchModel: shouldPatchDeepSeekV4OpenRouterPayload,
		resolveReasoningEffort: resolveOpenRouterDeepSeekV4ReasoningEffort
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

import { t as createSubsystemLogger } from "./subsystem-CgTF-J8V.js";
import { b as stripTrailingAssistantPrefillMessages, r as createDeepSeekV4OpenAICompatibleThinkingWrapper, s as createPayloadPatchStreamWrapper } from "./provider-stream-shared-BGzoIsk9.js";
import "./runtime-env-PjQ_OX8O.js";
import { o as OPENROUTER_THINKING_STREAM_HOOKS } from "./provider-stream-C_hbjWew.js";
import "./provider-stream-family-Bi8zqEKJ.js";
import { i as normalizeOpenRouterBaseUrl, r as isOpenRouterProxyReasoningUnsupportedModel, t as OPENROUTER_BASE_URL } from "./provider-catalog-BF8udsKj.js";
//#region extensions/openrouter/stream.ts
const log = createSubsystemLogger("openrouter-stream");
function readString(value) {
	return typeof value === "string" ? value.trim() : void 0;
}
function isOpenRouterAnthropicModelId(modelId) {
	const normalized = readString(modelId)?.toLowerCase();
	return normalized?.startsWith("anthropic/") === true || normalized?.startsWith("openrouter/anthropic/") === true;
}
function normalizeOpenRouterModelId(modelId) {
	const normalized = readString(modelId)?.toLowerCase();
	return normalized?.startsWith("openrouter/") ? normalized.slice(11) : normalized;
}
function isOpenRouterDeepSeekV4ModelId(modelId) {
	const normalized = normalizeOpenRouterModelId(modelId);
	if (!normalized?.startsWith("deepseek/")) return false;
	const deepSeekModelId = normalized.slice(9).split(":", 1)[0];
	return deepSeekModelId === "deepseek-v4-flash" || deepSeekModelId === "deepseek-v4-pro";
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
		shouldPatchModel: shouldPatchDeepSeekV4OpenRouterPayload
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
const __testing = {
	isOpenRouterDeepSeekV4ModelId,
	isOpenRouterAnthropicModelId,
	isOpenRouterReasoningPayloadEnabled,
	isVerifiedOpenRouterRoute,
	shouldPatchDeepSeekV4OpenRouterPayload,
	shouldPatchAnthropicOpenRouterPayload
};
//#endregion
export { wrapOpenRouterProviderStream as n, __testing as t };

import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { m as isOpenAICompatibleThinkingEnabled, o as createPayloadPatchStreamWrapper } from "./provider-stream-shared-jI_a6bxx.js";
import "./provider-model-shared-DtsPmvDx.js";
//#region extensions/qwen/stream.ts
function isQwenProviderId(providerId) {
	const normalized = normalizeProviderId(providerId);
	return normalized === "qwen" || normalized === "modelstudio" || normalized === "qwencloud" || normalized === "dashscope";
}
function setQwenChatTemplateThinking(payload, enabled) {
	const existing = payload.chat_template_kwargs;
	if (existing && typeof existing === "object" && !Array.isArray(existing)) {
		const next = {
			...existing,
			enable_thinking: enabled
		};
		if (!Object.hasOwn(next, "preserve_thinking")) next.preserve_thinking = true;
		payload.chat_template_kwargs = next;
		return;
	}
	payload.chat_template_kwargs = {
		enable_thinking: enabled,
		preserve_thinking: true
	};
}
function readQwenThinkingFormatFromModel(model) {
	if (model.api !== "openai-completions") return;
	const compat = model.compat && typeof model.compat === "object" ? model.compat : void 0;
	return typeof compat?.thinkingFormat === "string" ? compat.thinkingFormat : void 0;
}
function createQwenThinkingWrapper(baseStreamFn, thinkingLevel, thinkingFormat) {
	return createPayloadPatchStreamWrapper(baseStreamFn, ({ payload: payloadObj, model, options }) => {
		const enableThinking = isOpenAICompatibleThinkingEnabled({
			thinkingLevel,
			options
		});
		if ((thinkingFormat ?? readQwenThinkingFormatFromModel(model)) === "qwen-chat-template") {
			setQwenChatTemplateThinking(payloadObj, enableThinking);
			delete payloadObj.enable_thinking;
		} else payloadObj.enable_thinking = enableThinking;
		delete payloadObj.reasoning_effort;
		delete payloadObj.reasoningEffort;
		delete payloadObj.reasoning;
	}, { shouldPatch: ({ model }) => model.api === "openai-completions" && model.reasoning });
}
function wrapQwenProviderStream(ctx) {
	if (!isQwenProviderId(ctx.provider) || ctx.model && ctx.model.api !== "openai-completions") return;
	return createQwenThinkingWrapper(ctx.streamFn, ctx.thinkingLevel, ctx.model ? readQwenThinkingFormatFromModel(ctx.model) : void 0);
}
//#endregion
export { wrapQwenProviderStream as n, createQwenThinkingWrapper as t };

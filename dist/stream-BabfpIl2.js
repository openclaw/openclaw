import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { m as isOpenAICompatibleThinkingEnabled, o as createPayloadPatchStreamWrapper } from "./provider-stream-shared-jI_a6bxx.js";
import "./provider-model-shared-DtsPmvDx.js";
//#region extensions/vllm/stream.ts
function isVllmProviderId(providerId) {
	return normalizeProviderId(providerId) === "vllm";
}
function normalizeQwenThinkingFormat(value) {
	if (typeof value !== "string") return;
	const normalized = value.trim().toLowerCase().replace(/_/g, "-");
	if (normalized === "chat-template" || normalized === "chat-template-kwargs" || normalized === "chat-template-kwarg" || normalized === "chat-template-arguments") return "chat-template";
	if (normalized === "top-level" || normalized === "enable-thinking" || normalized === "request-body") return "top-level";
}
function resolveVllmQwenThinkingFormat(extraParams) {
	return normalizeQwenThinkingFormat(extraParams?.qwenThinkingFormat ?? extraParams?.qwen_thinking_format);
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
function isVllmNemotronModel(model) {
	return model.api === "openai-completions" && typeof model.provider === "string" && normalizeProviderId(model.provider) === "vllm" && typeof model.id === "string" && /\bnemotron-3(?:[-_](?:nano|super|ultra))?\b/i.test(model.id);
}
function setNemotronThinkingOffChatTemplateKwargs(payload) {
	const defaults = {
		enable_thinking: false,
		force_nonempty_content: true
	};
	const existing = payload.chat_template_kwargs;
	payload.chat_template_kwargs = existing && typeof existing === "object" && !Array.isArray(existing) ? {
		...defaults,
		...existing
	} : defaults;
}
function createVllmQwenThinkingWrapper(params) {
	return createPayloadPatchStreamWrapper(params.baseStreamFn, ({ payload: payloadObj, options }) => {
		const enableThinking = isOpenAICompatibleThinkingEnabled({
			thinkingLevel: params.thinkingLevel,
			options
		});
		if (params.format === "chat-template") setQwenChatTemplateThinking(payloadObj, enableThinking);
		else payloadObj.enable_thinking = enableThinking;
		delete payloadObj.reasoning_effort;
		delete payloadObj.reasoningEffort;
		delete payloadObj.reasoning;
	}, { shouldPatch: ({ model }) => model.api === "openai-completions" && model.reasoning });
}
function createVllmProviderThinkingWrapper(params) {
	return createPayloadPatchStreamWrapper(params.qwenFormat ? createVllmQwenThinkingWrapper({
		baseStreamFn: params.baseStreamFn,
		format: params.qwenFormat,
		thinkingLevel: params.thinkingLevel
	}) : params.baseStreamFn, ({ payload: payloadObj }) => {
		setNemotronThinkingOffChatTemplateKwargs(payloadObj);
	}, { shouldPatch: ({ model }) => model.api === "openai-completions" && params.thinkingLevel === "off" && isVllmNemotronModel(model) });
}
function wrapVllmProviderStream(ctx) {
	if (!isVllmProviderId(ctx.provider) || ctx.model && ctx.model.api !== "openai-completions") return;
	const qwenFormat = resolveVllmQwenThinkingFormat(ctx.extraParams);
	const shouldHandleNemotron = ctx.thinkingLevel === "off" && isVllmNemotronModel({
		api: "openai-completions",
		provider: ctx.provider,
		id: ctx.modelId
	});
	if (!qwenFormat && !shouldHandleNemotron) return;
	return createVllmProviderThinkingWrapper({
		baseStreamFn: ctx.streamFn,
		qwenFormat,
		thinkingLevel: ctx.thinkingLevel
	});
}
//#endregion
export { createVllmQwenThinkingWrapper as n, wrapVllmProviderStream as r, createVllmProviderThinkingWrapper as t };

import { r as normalizeProviderId } from "./provider-id-Cz7K6wgK.js";
import "./provider-model-shared-D-slKnZa.js";
import { o as createPayloadPatchStreamWrapper, p as isOpenAICompatibleThinkingEnabled } from "./provider-stream-shared-BMzmRA_f.js";
//#region extensions/qwen/stream.ts
function isQwenProviderId(providerId) {
	const normalized = normalizeProviderId(providerId);
	return normalized === "qwen" || normalized === "modelstudio" || normalized === "qwencloud" || normalized === "dashscope";
}
function createQwenThinkingWrapper(baseStreamFn, thinkingLevel) {
	return createPayloadPatchStreamWrapper(baseStreamFn, ({ payload: payloadObj, options }) => {
		payloadObj.enable_thinking = isOpenAICompatibleThinkingEnabled({
			thinkingLevel,
			options
		});
		delete payloadObj.reasoning_effort;
		delete payloadObj.reasoningEffort;
		delete payloadObj.reasoning;
	}, { shouldPatch: ({ model }) => model.api === "openai-completions" && model.reasoning });
}
function wrapQwenProviderStream(ctx) {
	if (!isQwenProviderId(ctx.provider) || ctx.model && ctx.model.api !== "openai-completions") return;
	return createQwenThinkingWrapper(ctx.streamFn, ctx.thinkingLevel);
}
//#endregion
export { wrapQwenProviderStream as n, createQwenThinkingWrapper as t };

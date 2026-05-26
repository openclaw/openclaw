import { i as streamWithPayloadPatch } from "./moonshot-thinking-stream-wrappers-D3FMTw1i.js";
import { r as createDeepSeekV4OpenAICompatibleThinkingWrapper } from "./provider-stream-shared-jI_a6bxx.js";
import { t as isOpencodeGoKimiNoReasoningModelId } from "./provider-catalog-CPLia89-.js";
import { t as stripOpencodeGoKimiReasoningPayload } from "./reasoning-sanitizer-BA49xp2a.js";
//#region extensions/opencode-go/stream.ts
function isOpencodeGoDeepSeekV4ModelId(modelId) {
	return modelId === "deepseek-v4-flash" || modelId === "deepseek-v4-pro";
}
function createOpencodeGoDeepSeekV4Wrapper(baseStreamFn, thinkingLevel) {
	return createDeepSeekV4OpenAICompatibleThinkingWrapper({
		baseStreamFn,
		thinkingLevel,
		shouldPatchModel: (model) => model.provider === "opencode-go" && isOpencodeGoDeepSeekV4ModelId(model.id)
	});
}
function stripReasoningParams(payloadObj) {
	stripOpencodeGoKimiReasoningPayload(payloadObj);
}
function createOpencodeGoKimiNoReasoningWrapper(baseStreamFn) {
	if (!baseStreamFn) return;
	const underlying = baseStreamFn;
	return (model, context, options) => {
		if (model.provider !== "opencode-go" || !isOpencodeGoKimiNoReasoningModelId(model.id)) return underlying(model, context, options);
		return streamWithPayloadPatch(underlying, model, context, options, stripReasoningParams);
	};
}
function createOpencodeGoWrapper(baseStreamFn, thinkingLevel) {
	const kimiWrapped = createOpencodeGoKimiNoReasoningWrapper(baseStreamFn) ?? baseStreamFn;
	return createOpencodeGoDeepSeekV4Wrapper(kimiWrapped, thinkingLevel) ?? kimiWrapped;
}
//#endregion
export { createOpencodeGoKimiNoReasoningWrapper as n, createOpencodeGoWrapper as r, createOpencodeGoDeepSeekV4Wrapper as t };

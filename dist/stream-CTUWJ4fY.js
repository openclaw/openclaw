import { r as createDeepSeekV4OpenAICompatibleThinkingWrapper } from "./provider-stream-shared-BMzmRA_f.js";
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
//#endregion
export { createOpencodeGoDeepSeekV4Wrapper as t };

import { r as createDeepSeekV4OpenAICompatibleThinkingWrapper } from "./provider-stream-shared-DPCP2aNX.js";
import { a as isDeepSeekV4ModelRef } from "./models-39QHF5aK.js";
//#region extensions/deepseek/stream.ts
function createDeepSeekV4ThinkingWrapper(baseStreamFn, thinkingLevel) {
	return createDeepSeekV4OpenAICompatibleThinkingWrapper({
		baseStreamFn,
		thinkingLevel,
		shouldPatchModel: isDeepSeekV4ModelRef
	});
}
//#endregion
export { createDeepSeekV4ThinkingWrapper as t };

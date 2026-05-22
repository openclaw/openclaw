import { r as createDeepSeekV4OpenAICompatibleThinkingWrapper } from "./provider-stream-shared-BHWz2mTn.js";
import { a as isDeepSeekV4ModelRef } from "./models-BcqUSKSt.js";
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

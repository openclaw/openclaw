import { r as createDeepSeekV4OpenAICompatibleThinkingWrapper } from "./provider-stream-shared-PSG3LR4n.js";
import { a as isDeepSeekV4ModelRef } from "./models-BJV9Z5gI.js";
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

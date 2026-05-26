import { r as createDeepSeekV4OpenAICompatibleThinkingWrapper, s as createThinkingOnlyFinalTextWrapper } from "./provider-stream-shared-jI_a6bxx.js";
import { n as isMiMoReasoningModelRef } from "./thinking-K_YRDMzr.js";
//#region extensions/xiaomi/stream.ts
const MIMO_REASONING_AS_VISIBLE_TEXT_MODEL_IDS = new Set(["mimo-v2-pro", "mimo-v2-omni"]);
function normalizeMiMoModelId(modelId) {
	if (typeof modelId !== "string") return;
	const normalized = modelId.trim().toLowerCase().split(":", 1)[0];
	if (!normalized) return;
	const parts = normalized.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? normalized;
}
function shouldPromoteMiMoReasoningToVisibleText(model) {
	return model.provider === "xiaomi" && MIMO_REASONING_AS_VISIBLE_TEXT_MODEL_IDS.has(normalizeMiMoModelId(model.id) ?? "");
}
function createMiMoThinkingWrapper(baseStreamFn, thinkingLevel) {
	return createThinkingOnlyFinalTextWrapper({
		baseStreamFn: createDeepSeekV4OpenAICompatibleThinkingWrapper({
			baseStreamFn,
			thinkingLevel,
			shouldPatchModel: isMiMoReasoningModelRef
		}),
		shouldPatchModel: shouldPromoteMiMoReasoningToVisibleText
	});
}
//#endregion
export { createMiMoThinkingWrapper as t };

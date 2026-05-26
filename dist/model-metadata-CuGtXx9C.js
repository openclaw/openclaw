import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
//#region extensions/github-copilot/model-metadata.ts
const COPILOT_CHAT_COMPLETIONS_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsUsageInStreaming: false,
	maxTokensField: "max_tokens"
};
const STATIC_MODEL_OVERRIDES = new Map([["gpt-5.5", {
	name: "GPT-5.5",
	reasoning: true,
	contextWindow: 4e5,
	maxTokens: 128e3
}]]);
function isCopilotGeminiModelId(modelId) {
	return /(?:^|[-_.])gemini(?:$|[-_.])/.test(modelId);
}
function resolveCopilotTransportApi(modelId) {
	const normalized = normalizeOptionalLowercaseString(modelId) ?? "";
	if (normalized.includes("claude")) return "anthropic-messages";
	if (isCopilotGeminiModelId(normalized)) return "openai-completions";
	return "openai-responses";
}
function resolveCopilotModelCompat(modelId) {
	return isCopilotGeminiModelId(normalizeOptionalLowercaseString(modelId) ?? "") ? { ...COPILOT_CHAT_COMPLETIONS_COMPAT } : void 0;
}
function resolveStaticCopilotModelOverride(modelId) {
	return STATIC_MODEL_OVERRIDES.get(normalizeOptionalLowercaseString(modelId) ?? "");
}
//#endregion
export { resolveCopilotTransportApi as n, resolveStaticCopilotModelOverride as r, resolveCopilotModelCompat as t };

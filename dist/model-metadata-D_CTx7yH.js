import { s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import "./string-coerce-runtime-Ce59bOpy.js";
//#region extensions/github-copilot/model-metadata.ts
const STATIC_MODEL_OVERRIDES = new Map([["gpt-5.5", {
	name: "GPT-5.5",
	reasoning: true,
	contextWindow: 4e5,
	maxTokens: 128e3
}]]);
function resolveCopilotTransportApi(modelId) {
	return (normalizeOptionalLowercaseString(modelId) ?? "").includes("claude") ? "anthropic-messages" : "openai-responses";
}
function resolveStaticCopilotModelOverride(modelId) {
	return STATIC_MODEL_OVERRIDES.get(normalizeOptionalLowercaseString(modelId) ?? "");
}
//#endregion
export { resolveStaticCopilotModelOverride as n, resolveCopilotTransportApi as t };

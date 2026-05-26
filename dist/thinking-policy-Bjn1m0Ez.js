import { t as isOpenRouterDeepSeekV4ModelId } from "./models-DN48-hmx.js";
//#region extensions/openrouter/thinking-policy.ts
const OPENROUTER_DEEPSEEK_V4_THINKING_LEVEL_IDS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh"
];
function buildOpenRouterDeepSeekV4ThinkingLevel(id) {
	return { id };
}
const OPENROUTER_DEEPSEEK_V4_THINKING_PROFILE = {
	levels: OPENROUTER_DEEPSEEK_V4_THINKING_LEVEL_IDS.map(buildOpenRouterDeepSeekV4ThinkingLevel),
	defaultLevel: "high"
};
function supportsOpenRouterXHighThinking(modelId) {
	return isOpenRouterDeepSeekV4ModelId(modelId);
}
function resolveOpenRouterThinkingProfile(modelId) {
	return isOpenRouterDeepSeekV4ModelId(modelId) ? OPENROUTER_DEEPSEEK_V4_THINKING_PROFILE : void 0;
}
//#endregion
export { supportsOpenRouterXHighThinking as n, resolveOpenRouterThinkingProfile as t };

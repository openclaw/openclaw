import { i as isDeepSeekV4ModelId } from "./models-CMCEiKpv.js";
//#region extensions/deepseek/thinking.ts
const V4_THINKING_LEVEL_IDS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
function buildDeepSeekV4ThinkingLevel(id) {
	return { id };
}
const DEEPSEEK_V4_THINKING_PROFILE = {
	levels: V4_THINKING_LEVEL_IDS.map(buildDeepSeekV4ThinkingLevel),
	defaultLevel: "high"
};
function resolveDeepSeekV4ThinkingProfile(modelId) {
	return isDeepSeekV4ModelId(modelId) ? DEEPSEEK_V4_THINKING_PROFILE : void 0;
}
//#endregion
export { resolveDeepSeekV4ThinkingProfile as t };

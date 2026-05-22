import { t as isFireworksKimiModelId } from "./model-id-Cm6YGv-5.js";
//#region extensions/fireworks/thinking-policy.ts
const FIREWORKS_KIMI_THINKING_PROFILE = {
	levels: [{ id: "off" }],
	defaultLevel: "off"
};
function resolveFireworksThinkingProfile(modelId) {
	if (!isFireworksKimiModelId(modelId)) return;
	return FIREWORKS_KIMI_THINKING_PROFILE;
}
//#endregion
export { resolveFireworksThinkingProfile as t };

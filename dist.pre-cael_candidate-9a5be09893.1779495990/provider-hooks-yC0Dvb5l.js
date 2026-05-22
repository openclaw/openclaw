import { n as buildProviderToolCompatFamilyHooks } from "./provider-tools-D8Ja_oUH.js";
import { a as createGoogleThinkingStreamWrapper, d as isGoogleGemini3ProModel } from "./provider-stream-shared-THmVlO_U.js";
import { a as buildProviderReplayFamilyHooks } from "./provider-model-shared-DsnTZA_6.js";
import "./thinking-api-TKRyMyk-.js";
//#region extensions/google/provider-hooks.ts
const GOOGLE_GEMINI_PROVIDER_HOOKS = {
	...buildProviderReplayFamilyHooks({ family: "google-gemini" }),
	...buildProviderToolCompatFamilyHooks("gemini"),
	resolveThinkingProfile: ({ modelId }) => ({ levels: isGoogleGemini3ProModel(modelId) ? [
		{ id: "off" },
		{ id: "low" },
		{ id: "adaptive" },
		{ id: "high" }
	] : [
		{ id: "off" },
		{ id: "minimal" },
		{ id: "low" },
		{ id: "medium" },
		{ id: "adaptive" },
		{ id: "high" }
	] }),
	wrapStreamFn: createGoogleThinkingStreamWrapper
};
//#endregion
export { GOOGLE_GEMINI_PROVIDER_HOOKS as t };

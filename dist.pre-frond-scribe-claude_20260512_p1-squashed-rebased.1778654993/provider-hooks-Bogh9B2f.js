import { t as buildProviderToolCompatFamilyHooks } from "./provider-tools-2EF_PdCY.js";
import { a as buildProviderReplayFamilyHooks } from "./provider-model-shared-Bukkx1JT.js";
import { a as createGoogleThinkingStreamWrapper, u as isGoogleGemini3ProModel } from "./provider-stream-shared-62uIICYS.js";
import "./thinking-api-DRKymb7G.js";
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

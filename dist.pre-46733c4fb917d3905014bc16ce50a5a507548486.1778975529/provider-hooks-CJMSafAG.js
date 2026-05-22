import { t as buildProviderToolCompatFamilyHooks } from "./provider-tools-CWTapSmF.js";
import { a as buildProviderReplayFamilyHooks } from "./provider-model-shared-BDPvUGt6.js";
import { a as createGoogleThinkingStreamWrapper, d as isGoogleGemini3ProModel } from "./provider-stream-shared-CY-BNuZa.js";
import "./thinking-api-3AO2jR8P.js";
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

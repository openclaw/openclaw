import { t as buildProviderToolCompatFamilyHooks } from "./provider-tools-BTWF-rOZ.js";
import { a as buildProviderReplayFamilyHooks } from "./provider-model-shared-Cgj-cjho.js";
import { a as createGoogleThinkingStreamWrapper, u as isGoogleGemini3ProModel } from "./provider-stream-shared-HNSzC3XK.js";
import "./thinking-api-Bal-0Apq.js";
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

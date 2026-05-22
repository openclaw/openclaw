import { a as buildProviderToolCompatFamilyHooks } from "./provider-tools-DgOkcG5J.js";
import { a as buildProviderReplayFamilyHooks } from "./provider-model-shared-BJrHvRZi.js";
import { a as createGoogleThinkingStreamWrapper, f as isGoogleGemini3ProModel } from "./provider-stream-shared-CN5xC3-5.js";
import "./thinking-api-BDScpI9T.js";
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

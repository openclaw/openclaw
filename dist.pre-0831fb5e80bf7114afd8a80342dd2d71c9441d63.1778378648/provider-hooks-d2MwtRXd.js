import { a as buildProviderToolCompatFamilyHooks } from "./provider-tools-CUksBU_o.js";
import { a as buildProviderReplayFamilyHooks } from "./provider-model-shared-CaJQJU2U.js";
import { a as createGoogleThinkingStreamWrapper, f as isGoogleGemini3ProModel } from "./provider-stream-shared-rmiwTBqI.js";
import "./thinking-api-BZz2KWjR.js";
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

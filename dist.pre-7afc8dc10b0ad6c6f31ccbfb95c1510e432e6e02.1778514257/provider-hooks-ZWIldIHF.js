import { a as buildProviderToolCompatFamilyHooks } from "./provider-tools-AcSjASfb.js";
import { a as buildProviderReplayFamilyHooks } from "./provider-model-shared-DcESXin-.js";
import { a as createGoogleThinkingStreamWrapper, f as isGoogleGemini3ProModel } from "./provider-stream-shared-CZg7LGwE.js";
import "./thinking-api-BgGxN9X_.js";
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

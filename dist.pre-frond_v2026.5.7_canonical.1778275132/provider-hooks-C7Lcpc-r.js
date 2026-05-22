import { a as buildProviderReplayFamilyHooks } from "./provider-model-shared-EoaoyeJq.js";
import { a as createGoogleThinkingStreamWrapper, f as isGoogleGemini3ProModel } from "./provider-stream-shared-Cq45fRri.js";
import "./thinking-api-DcWZzy2y.js";
//#region extensions/google/provider-hooks.ts
const GOOGLE_GEMINI_PROVIDER_HOOKS = {
	...buildProviderReplayFamilyHooks({ family: "google-gemini" }),
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

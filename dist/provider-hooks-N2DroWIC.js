import { n as buildProviderToolCompatFamilyHooks } from "./provider-tools-D8Ja_oUH.js";
import { a as createGoogleThinkingStreamWrapper } from "./provider-stream-shared-jI_a6bxx.js";
import { a as buildProviderReplayFamilyHooks } from "./provider-model-shared-DtsPmvDx.js";
import "./thinking-api-Cziq3sR-.js";
import { c as resolveGoogleThinkingProfile } from "./provider-policy-C3QGAGLZ.js";
//#region extensions/google/provider-hooks.ts
const GOOGLE_GEMINI_PROVIDER_HOOKS = {
	...buildProviderReplayFamilyHooks({ family: "google-gemini" }),
	...buildProviderToolCompatFamilyHooks("gemini"),
	resolveThinkingProfile: (context) => resolveGoogleThinkingProfile(context),
	wrapStreamFn: createGoogleThinkingStreamWrapper
};
//#endregion
export { GOOGLE_GEMINI_PROVIDER_HOOKS as t };

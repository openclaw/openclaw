import { n as buildProviderToolCompatFamilyHooks } from "./provider-tools-D8Ja_oUH.js";
import { a as createGoogleThinkingStreamWrapper } from "./provider-stream-shared-THmVlO_U.js";
import { a as buildProviderReplayFamilyHooks } from "./provider-model-shared-DsnTZA_6.js";
import "./thinking-api-TKRyMyk-.js";
import { c as resolveGoogleThinkingProfile } from "./provider-policy-BDvRcWsz.js";
//#region extensions/google/provider-hooks.ts
const GOOGLE_GEMINI_PROVIDER_HOOKS = {
	...buildProviderReplayFamilyHooks({ family: "google-gemini" }),
	...buildProviderToolCompatFamilyHooks("gemini"),
	resolveThinkingProfile: (context) => resolveGoogleThinkingProfile(context),
	wrapStreamFn: createGoogleThinkingStreamWrapper
};
//#endregion
export { GOOGLE_GEMINI_PROVIDER_HOOKS as t };

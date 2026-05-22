import { t as resolveFireworksThinkingProfile } from "../../thinking-policy-DP2CB90N.js";

//#region extensions/fireworks/provider-policy-api.d.ts
declare function resolveThinkingProfile(params: {
  provider?: string;
  modelId: string;
}): ReturnType<typeof resolveFireworksThinkingProfile>;
//#endregion
export { resolveThinkingProfile };
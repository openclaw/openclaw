import { t as resolveFireworksThinkingProfile } from "../../thinking-policy-Dre42-nm.js";

//#region extensions/fireworks/provider-policy-api.d.ts
declare function resolveThinkingProfile(params: {
  provider?: string;
  modelId: string;
}): ReturnType<typeof resolveFireworksThinkingProfile>;
//#endregion
export { resolveThinkingProfile };
import { t as resolveFireworksThinkingProfile } from "../../thinking-policy-Bm7px_1b.js";

//#region extensions/fireworks/provider-policy-api.d.ts
declare function resolveThinkingProfile(params: {
  provider?: string;
  modelId: string;
}): ReturnType<typeof resolveFireworksThinkingProfile>;
//#endregion
export { resolveThinkingProfile };
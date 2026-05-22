import { Zn as ProviderThinkingProfile } from "../../types-CPAF_tyr.js";
//#region extensions/opencode/provider-policy-api.d.ts
declare function resolveThinkingProfile(params: {
  provider?: string;
  modelId: string;
}): ProviderThinkingProfile;
//#endregion
export { resolveThinkingProfile };
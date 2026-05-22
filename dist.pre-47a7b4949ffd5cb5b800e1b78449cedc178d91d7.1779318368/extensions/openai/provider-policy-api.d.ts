import { l as ModelProviderConfig } from "../../types.models-D7TQ4_r1.js";
import { Zn as ProviderThinkingProfile } from "../../types-WgmX6DKe.js";
//#region extensions/openai/provider-policy-api.d.ts
declare function normalizeConfig(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
}): ModelProviderConfig;
declare function resolveThinkingProfile(params: {
  provider: string;
  modelId: string;
}): ProviderThinkingProfile | null;
//#endregion
export { normalizeConfig, resolveThinkingProfile };
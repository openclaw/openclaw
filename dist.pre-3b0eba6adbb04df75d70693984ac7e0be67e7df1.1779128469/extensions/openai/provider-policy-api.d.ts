import { l as ModelProviderConfig } from "../../types.models-DPSsoV9Y.js";
import { Zn as ProviderThinkingProfile } from "../../types-_HTuWOFH.js";
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
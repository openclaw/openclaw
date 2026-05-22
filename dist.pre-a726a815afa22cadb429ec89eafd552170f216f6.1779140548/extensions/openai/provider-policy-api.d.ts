import { l as ModelProviderConfig } from "../../types.models-DuD4I8NY.js";
import { Zn as ProviderThinkingProfile } from "../../types-Bb8qdnX4.js";
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
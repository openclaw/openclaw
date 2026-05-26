import { u as ModelProviderConfig } from "../../types.models-tqxsISRc.js";
import { Yn as ProviderDefaultThinkingPolicyContext, Zn as ProviderThinkingProfile } from "../../types-Vx7Jq4_-2.js";
//#region extensions/google/provider-policy-api.d.ts
declare function normalizeConfig(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
}): ModelProviderConfig;
declare function resolveThinkingProfile(context: ProviderDefaultThinkingPolicyContext): ProviderThinkingProfile | undefined;
//#endregion
export { normalizeConfig, resolveThinkingProfile };
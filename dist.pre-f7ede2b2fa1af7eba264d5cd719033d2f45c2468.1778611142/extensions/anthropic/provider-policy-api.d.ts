import { i as OpenClawConfig } from "../../types.openclaw-BlE9q7jU.js";
import { l as ModelProviderConfig } from "../../types.models-fxeqhDwC.js";
import { Kn as ProviderThinkingProfile } from "../../types-DKA4S1yN.js";
import { t as applyAnthropicConfigDefaults } from "../../config-defaults-jv1Nl_xF.js";
//#region extensions/anthropic/provider-policy-api.d.ts
declare function normalizeConfig(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
}): ModelProviderConfig;
declare function applyConfigDefaults(params: Parameters<typeof applyAnthropicConfigDefaults>[0]): OpenClawConfig;
declare function resolveThinkingProfile(params: {
  provider: string;
  modelId: string;
}): ProviderThinkingProfile | null;
//#endregion
export { applyConfigDefaults, normalizeConfig, resolveThinkingProfile };
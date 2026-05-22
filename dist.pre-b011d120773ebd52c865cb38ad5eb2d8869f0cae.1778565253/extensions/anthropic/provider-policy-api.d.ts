import { i as OpenClawConfig } from "../../types.openclaw-BdZr8Ncl.js";
import { l as ModelProviderConfig } from "../../types.models-DMZzPEHb.js";
import { Kn as ProviderThinkingProfile } from "../../types-CyE3PKKi.js";
import { t as applyAnthropicConfigDefaults } from "../../config-defaults-DeqRfkne.js";
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
import { i as OpenClawConfig } from "../../types.openclaw-C9E_zZnO.js";
import { l as ModelProviderConfig } from "../../types.models-gg_vEQfc.js";
import { Rn as ProviderThinkingProfile } from "../../types-DaukV8xd.js";
import { t as applyAnthropicConfigDefaults } from "../../config-defaults-PYTDky4G.js";
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
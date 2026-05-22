import { i as OpenClawConfig } from "../../types.openclaw-DBDmmaVM.js";
import { l as ModelProviderConfig } from "../../types.models-BQ31eD8b.js";
import { Zn as ProviderThinkingProfile } from "../../types-CPAF_tyr.js";
import { t as applyAnthropicConfigDefaults } from "../../config-defaults-CYyISdzo.js";
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
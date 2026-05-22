import { i as OpenClawConfig } from "../../types.openclaw-GamulG8g.js";
import { u as ModelProviderConfig } from "../../types.models-ChAkWQv6.js";
import { Zn as ProviderThinkingProfile } from "../../types-DolEO2Jl.js";
import { t as applyAnthropicConfigDefaults } from "../../config-defaults-Z81Ev86Q.js";
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
import { i as OpenClawConfig } from "../../types.openclaw-Bpxi7OSY.js";
import { l as ModelProviderConfig } from "../../types.models-RkUtNnv-.js";
import { Zn as ProviderThinkingProfile } from "../../types-Cdl1yOYR.js";
import { t as applyAnthropicConfigDefaults } from "../../config-defaults-BlUa1V5v.js";
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
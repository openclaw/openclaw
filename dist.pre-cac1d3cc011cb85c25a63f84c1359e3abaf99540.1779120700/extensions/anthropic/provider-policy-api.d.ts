import { i as OpenClawConfig } from "../../types.openclaw-C58U02FA.js";
import { l as ModelProviderConfig } from "../../types.models-BCM1Na_a.js";
import { Zn as ProviderThinkingProfile } from "../../types-UTp4ves_.js";
import { t as applyAnthropicConfigDefaults } from "../../config-defaults-DN_VNO-b.js";
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
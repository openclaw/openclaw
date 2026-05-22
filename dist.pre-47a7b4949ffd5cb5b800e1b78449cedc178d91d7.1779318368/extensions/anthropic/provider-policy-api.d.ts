import { i as OpenClawConfig } from "../../types.openclaw-Cy0U3Gwh.js";
import { l as ModelProviderConfig } from "../../types.models-D7TQ4_r1.js";
import { Zn as ProviderThinkingProfile } from "../../types-WgmX6DKe.js";
import { t as applyAnthropicConfigDefaults } from "../../config-defaults-Cvfy25IE.js";
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
import { i as OpenClawConfig } from "../../types.openclaw-DNoZmPZ8.js";
import { l as ModelProviderConfig } from "../../types.models-DfLOOuHc.js";
import { Kn as ProviderThinkingProfile } from "../../types-CT4HF0Ri.js";
import { t as applyAnthropicConfigDefaults } from "../../config-defaults-Bdset4tU.js";
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
import { i as OpenClawConfig } from "../../types.openclaw-BuKAF4PW.js";
import { l as ModelProviderConfig } from "../../types.models-DIMxudWn.js";
import { qn as ProviderThinkingProfile } from "../../types-9OpM7mYQ.js";
import { t as applyAnthropicConfigDefaults } from "../../config-defaults-Cy68IEKv.js";
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
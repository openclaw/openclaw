import { i as OpenClawConfig } from "../../types.openclaw-BdSNxnBz.js";
import { l as ModelProviderConfig } from "../../types.models-KERO8F0O.js";
import { Kn as ProviderThinkingProfile } from "../../types-ItMBrbf4.js";
import { t as applyAnthropicConfigDefaults } from "../../config-defaults-DlXCxi5w.js";
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
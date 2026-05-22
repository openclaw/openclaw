import { i as OpenClawConfig } from "../../types.openclaw-C5VNg6h3.js";
import { l as ModelProviderConfig } from "../../types.models-DIMxudWn.js";
import { qn as ProviderThinkingProfile } from "../../types-Dggwf5Fv.js";
import { t as applyAnthropicConfigDefaults } from "../../config-defaults-BM3tVpA3.js";
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
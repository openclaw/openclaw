import { i as OpenClawConfig } from "../../types.openclaw-CoVv5VQR.js";
import { l as ModelProviderConfig } from "../../types.models-BbSYPJk1.js";
import { Rn as ProviderThinkingProfile } from "../../types-BYigPDoy.js";
import { t as applyAnthropicConfigDefaults } from "../../config-defaults-D7w2v3xh.js";
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
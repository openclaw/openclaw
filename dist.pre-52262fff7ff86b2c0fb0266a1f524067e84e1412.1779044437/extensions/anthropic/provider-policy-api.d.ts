import { i as OpenClawConfig } from "../../types.openclaw-BMMD0Ykw.js";
import { l as ModelProviderConfig } from "../../types.models-BPif7RZm.js";
import { qn as ProviderThinkingProfile } from "../../types-DzWIJtb62.js";
import { t as applyAnthropicConfigDefaults } from "../../config-defaults-DHXWjlN0.js";
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
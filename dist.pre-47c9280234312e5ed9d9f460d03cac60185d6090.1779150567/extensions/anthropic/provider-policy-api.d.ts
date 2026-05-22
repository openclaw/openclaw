import { i as OpenClawConfig } from "../../types.openclaw-CQzDxdpQ.js";
import { l as ModelProviderConfig } from "../../types.models-DuD4I8NY.js";
import { Zn as ProviderThinkingProfile } from "../../types-B1YsHkjI.js";
import { t as applyAnthropicConfigDefaults } from "../../config-defaults-BvQnhu3f.js";
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
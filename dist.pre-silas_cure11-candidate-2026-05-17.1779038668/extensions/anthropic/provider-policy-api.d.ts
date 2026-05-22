import { i as OpenClawConfig } from "../../types.openclaw-D8bJSZjd.js";
import { l as ModelProviderConfig } from "../../types.models-BWww8ZiS.js";
import { qn as ProviderThinkingProfile } from "../../types-wNLvWYuA.js";
import { t as applyAnthropicConfigDefaults } from "../../config-defaults-kWPvajKh.js";
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
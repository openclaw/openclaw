import { i as OpenClawConfig } from "../../types.openclaw-DZQrhn8E.js";
import { l as ModelProviderConfig } from "../../types.models-DPSsoV9Y.js";
import { Zn as ProviderThinkingProfile } from "../../types-_HTuWOFH.js";
import { t as applyAnthropicConfigDefaults } from "../../config-defaults-Ck7tx9mf.js";
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
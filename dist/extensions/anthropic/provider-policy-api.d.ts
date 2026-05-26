import { i as OpenClawConfig } from "../../types.openclaw-DIZy8jcb.js";
import { l as ModelProviderConfig } from "../../types.models-CkWCv1xp.js";
import { Kn as ProviderThinkingProfile } from "../../types-lCXG2pW_.js";
import { t as applyAnthropicConfigDefaults } from "../../config-defaults-DeuynI1b.js";
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
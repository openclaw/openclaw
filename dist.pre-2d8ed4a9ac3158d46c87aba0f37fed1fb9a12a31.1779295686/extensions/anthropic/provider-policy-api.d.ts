import { i as OpenClawConfig } from "../../types.openclaw-DPnlcagS.js";
import { l as ModelProviderConfig } from "../../types.models-CpHuMVwj.js";
import { Zn as ProviderThinkingProfile } from "../../types-D0OCNFd4.js";
import { t as applyAnthropicConfigDefaults } from "../../config-defaults-CLMgKg3g.js";
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
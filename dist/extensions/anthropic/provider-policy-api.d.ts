import { i as OpenClawConfig } from "../../types.openclaw-BLF4DJTX.js";
import { u as ModelProviderConfig } from "../../types.models-tqxsISRc.js";
import { Zn as ProviderThinkingProfile } from "../../types-Vx7Jq4_-2.js";
import { t as applyAnthropicConfigDefaults } from "../../config-defaults-CEqhHVDL.js";
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
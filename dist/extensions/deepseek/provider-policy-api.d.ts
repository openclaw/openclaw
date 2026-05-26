import { u as ModelProviderConfig } from "../../types.models-tqxsISRc.js";
import { Zn as ProviderThinkingProfile } from "../../types-Vx7Jq4_-2.js";
//#region extensions/deepseek/provider-policy-api.d.ts
/**
 * Provider policy surface for DeepSeek.
 *
 * Hydrates missing `contextWindow`, `cost`, and `maxTokens` from the bundled
 * catalog for matching model ids. Explicit user overrides are preserved.
 */
declare function normalizeConfig(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
}): ModelProviderConfig;
declare function resolveThinkingProfile(params: {
  provider: string;
  modelId: string;
}): ProviderThinkingProfile | null | undefined;
//#endregion
export { normalizeConfig, resolveThinkingProfile };
import { l as ModelProviderConfig } from "../../types.models-BWww8ZiS.js";
import { qn as ProviderThinkingProfile } from "../../types-DdGVOQ6y.js";
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
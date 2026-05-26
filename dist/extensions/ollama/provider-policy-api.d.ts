import { u as ModelProviderConfig } from "../../types.models-tqxsISRc.js";
import { Zn as ProviderThinkingProfile } from "../../types-Vx7Jq4_-2.js";
//#region extensions/ollama/provider-policy-api.d.ts
type OllamaProviderConfigDraft = Partial<ModelProviderConfig>;
/**
 * Provider policy surface for Ollama: normalize provider configs used by
 * core defaults/normalizers. This runs during config defaults application and
 * normalization paths (not Zod validation).
 */
declare function normalizeConfig({
  provider,
  providerConfig
}: {
  provider: string;
  providerConfig: OllamaProviderConfigDraft;
}): OllamaProviderConfigDraft;
declare function resolveThinkingProfile({
  reasoning
}: {
  reasoning?: boolean;
}): ProviderThinkingProfile;
//#endregion
export { normalizeConfig, resolveThinkingProfile };
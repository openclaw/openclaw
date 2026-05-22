import { Kn as ProviderThinkingProfile } from "../../types-DKA4S1yN.js";
//#region extensions/openai/thinking-policy.d.ts
declare function resolveOpenAIThinkingProfile(modelId: string): ProviderThinkingProfile;
declare function resolveOpenAICodexThinkingProfile(modelId: string): ProviderThinkingProfile;
//#endregion
export { resolveOpenAICodexThinkingProfile, resolveOpenAIThinkingProfile };
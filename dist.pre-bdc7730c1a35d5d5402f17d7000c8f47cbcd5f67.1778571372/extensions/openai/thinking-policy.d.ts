import { Kn as ProviderThinkingProfile } from "../../types-D1CySu2x.js";
//#region extensions/openai/thinking-policy.d.ts
declare function resolveOpenAIThinkingProfile(modelId: string): ProviderThinkingProfile;
declare function resolveOpenAICodexThinkingProfile(modelId: string): ProviderThinkingProfile;
//#endregion
export { resolveOpenAICodexThinkingProfile, resolveOpenAIThinkingProfile };
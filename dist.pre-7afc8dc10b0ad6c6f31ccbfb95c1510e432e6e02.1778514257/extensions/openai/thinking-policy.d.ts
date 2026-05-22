import { Rn as ProviderThinkingProfile } from "../../types-BOTb5nyG.js";
//#region extensions/openai/thinking-policy.d.ts
declare function resolveOpenAIThinkingProfile(modelId: string): ProviderThinkingProfile;
declare function resolveOpenAICodexThinkingProfile(modelId: string): ProviderThinkingProfile;
//#endregion
export { resolveOpenAICodexThinkingProfile, resolveOpenAIThinkingProfile };
import { qn as ProviderThinkingProfile } from "../../types-BM0xoSYJ2.js";
//#region extensions/openai/thinking-policy.d.ts
declare function resolveOpenAIThinkingProfile(modelId: string): ProviderThinkingProfile;
declare function resolveOpenAICodexThinkingProfile(modelId: string): ProviderThinkingProfile;
//#endregion
export { resolveOpenAICodexThinkingProfile, resolveOpenAIThinkingProfile };
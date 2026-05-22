import { Zn as ProviderThinkingProfile } from "../../types-Dw7_sm4q.js";
//#region extensions/openrouter/thinking-policy.d.ts
declare function supportsOpenRouterXHighThinking(modelId: string): boolean;
declare function resolveOpenRouterThinkingProfile(modelId: string): ProviderThinkingProfile | undefined;
//#endregion
export { resolveOpenRouterThinkingProfile, supportsOpenRouterXHighThinking };
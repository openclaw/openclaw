import { Kn as ProviderThinkingProfile } from "../../types-DKA4S1yN.js";
//#region extensions/openrouter/thinking-policy.d.ts
declare function supportsOpenRouterXHighThinking(modelId: string): boolean;
declare function resolveOpenRouterThinkingProfile(modelId: string): ProviderThinkingProfile | undefined;
//#endregion
export { resolveOpenRouterThinkingProfile, supportsOpenRouterXHighThinking };
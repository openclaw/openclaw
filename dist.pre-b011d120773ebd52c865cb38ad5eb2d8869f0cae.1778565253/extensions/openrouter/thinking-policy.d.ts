import { Kn as ProviderThinkingProfile } from "../../types-CyE3PKKi.js";
//#region extensions/openrouter/thinking-policy.d.ts
declare function supportsOpenRouterXHighThinking(modelId: string): boolean;
declare function resolveOpenRouterThinkingProfile(modelId: string): ProviderThinkingProfile | undefined;
//#endregion
export { resolveOpenRouterThinkingProfile, supportsOpenRouterXHighThinking };
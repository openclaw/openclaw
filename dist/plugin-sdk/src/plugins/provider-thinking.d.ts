import type { ProviderDefaultThinkingPolicyContext, ProviderThinkingProfile, ProviderThinkingPolicyContext } from "./provider-thinking.types.js";
type ThinkingHookParams<TContext> = {
    provider: string;
    context: TContext;
};
export declare function resolveProviderBinaryThinking(params: ThinkingHookParams<ProviderThinkingPolicyContext>): boolean | undefined;
export declare function resolveProviderXHighThinking(params: ThinkingHookParams<ProviderThinkingPolicyContext>): boolean | undefined;
export declare function resolveProviderThinkingProfile(params: ThinkingHookParams<ProviderDefaultThinkingPolicyContext>): ProviderThinkingProfile | null | undefined;
export declare function resolveProviderDefaultThinkingLevel(params: ThinkingHookParams<ProviderDefaultThinkingPolicyContext>): "adaptive" | "high" | "low" | "medium" | "minimal" | "off" | "xhigh" | null | undefined;
export {};

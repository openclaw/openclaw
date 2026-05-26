import type { TypingPolicy } from "../types.js";
export type ResolveRunTypingPolicyParams = {
    requestedPolicy?: TypingPolicy;
    suppressTyping?: boolean;
    isHeartbeat?: boolean;
    originatingChannel?: string;
    systemEvent?: boolean;
};
export type ResolvedRunTypingPolicy = {
    typingPolicy: TypingPolicy;
    suppressTyping: boolean;
};
export declare function resolveRunTypingPolicy(params: ResolveRunTypingPolicyParams): ResolvedRunTypingPolicy;

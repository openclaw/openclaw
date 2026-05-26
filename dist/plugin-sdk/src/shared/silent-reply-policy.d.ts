export type SilentReplyPolicy = "allow" | "disallow";
export type SilentReplyConversationType = "direct" | "group" | "internal";
export type SilentReplyPolicyShape = Partial<Record<Exclude<SilentReplyConversationType, "direct">, SilentReplyPolicy>>;
export declare const DEFAULT_SILENT_REPLY_POLICY: Record<SilentReplyConversationType, SilentReplyPolicy>;
export declare function classifySilentReplyConversationType(params: {
    sessionKey?: string;
    surface?: string;
    conversationType?: SilentReplyConversationType;
}): SilentReplyConversationType;
export declare function resolveSilentReplyPolicyFromPolicies(params: {
    conversationType: SilentReplyConversationType;
    defaultPolicy?: SilentReplyPolicyShape;
    surfacePolicy?: SilentReplyPolicyShape;
}): SilentReplyPolicy;

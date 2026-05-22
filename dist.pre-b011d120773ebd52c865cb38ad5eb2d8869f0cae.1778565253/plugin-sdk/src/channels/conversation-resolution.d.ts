import type { OpenClawConfig } from "../config/types.openclaw.js";
type ConversationResolutionSource = "command-provider" | "focused-binding" | "command-fallback" | "inbound-provider" | "inbound-bundled-artifact" | "inbound-bundled-plugin" | "inbound-fallback";
type ConversationResolution = {
    canonical: {
        channel: string;
        accountId: string;
        conversationId: string;
        parentConversationId?: string;
    };
    threadId?: string;
    placementHint?: "current" | "child";
    source: ConversationResolutionSource;
};
export type ResolveCommandConversationResolutionInput = {
    cfg: OpenClawConfig;
    channel?: string | null;
    accountId?: string | null;
    chatType?: string | null;
    threadId?: string | number | null;
    threadParentId?: string | null;
    senderId?: string | null;
    sessionKey?: string | null;
    parentSessionKey?: string | null;
    originatingTo?: string | null;
    commandTo?: string | null;
    fallbackTo?: string | null;
    from?: string | null;
    nativeChannelId?: string | null;
    includePlacementHint?: boolean;
};
type ResolveInboundConversationResolutionInput = {
    cfg: OpenClawConfig;
    channel?: string | null;
    accountId?: string | null;
    to?: string | null;
    threadId?: string | number | null;
    conversationId?: string | null;
    groupId?: string | null;
    from?: string | null;
    isGroup?: boolean;
};
export declare function resolveChannelDefaultBindingPlacement(rawChannel?: string | null): "current" | "child" | undefined;
export declare function resolveCommandConversationResolution(params: ResolveCommandConversationResolutionInput): ConversationResolution | null;
export declare function resolveInboundConversationResolution(params: ResolveInboundConversationResolutionInput): ConversationResolution | null;
export {};

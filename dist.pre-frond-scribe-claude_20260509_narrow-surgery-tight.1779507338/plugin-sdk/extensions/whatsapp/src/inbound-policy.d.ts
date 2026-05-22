import type { ChannelGroupPolicy, DmPolicy, GroupPolicy, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { type ResolvedWhatsAppAccount } from "./accounts.js";
import type { WebInboundMessage } from "./inbound/types.js";
export type ResolvedWhatsAppInboundPolicy = {
    account: ResolvedWhatsAppAccount;
    dmPolicy: DmPolicy;
    groupPolicy: GroupPolicy;
    configuredAllowFrom: string[];
    dmAllowFrom: string[];
    groupAllowFrom: string[];
    isSelfChat: boolean;
    providerMissingFallbackApplied: boolean;
    isSamePhone: (value?: string | null) => boolean;
    resolveConversationGroupPolicy: (conversationId: string) => ChannelGroupPolicy;
    resolveConversationRequireMention: (conversationId: string) => boolean;
};
export declare function resolveWhatsAppInboundPolicy(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    selfE164?: string | null;
}): ResolvedWhatsAppInboundPolicy;
export declare function resolveWhatsAppIngressAccess(params: {
    cfg: OpenClawConfig;
    policy: ResolvedWhatsAppInboundPolicy;
    isGroup: boolean;
    conversationId: string;
    senderId?: string | null;
    dmSenderId?: string | null;
    includeCommand?: boolean;
}): Promise<import("openclaw/plugin-sdk/channel-ingress-runtime").ResolvedChannelMessageIngress>;
export declare function resolveWhatsAppCommandAuthorized(params: {
    cfg: OpenClawConfig;
    msg: WebInboundMessage;
    policy?: ResolvedWhatsAppInboundPolicy;
}): Promise<boolean>;

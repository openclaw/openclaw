import type { ChannelId } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "./config.js";
import { type GroupToolPolicyBySenderConfig, type GroupToolPolicyConfig } from "./types.tools.js";
export type GroupPolicyChannel = ChannelId;
export type ChannelGroupConfig = {
    requireMention?: boolean;
    tools?: GroupToolPolicyConfig;
    toolsBySender?: GroupToolPolicyBySenderConfig;
};
export type ChannelGroupPolicy = {
    allowlistEnabled: boolean;
    allowed: boolean;
    groupConfig?: ChannelGroupConfig;
    defaultConfig?: ChannelGroupConfig;
};
export type GroupToolPolicySender = {
    senderId?: string | null;
    senderName?: string | null;
    senderUsername?: string | null;
    senderE164?: string | null;
};
export declare function resolveToolsBySender(params: {
    toolsBySender?: GroupToolPolicyBySenderConfig;
} & GroupToolPolicySender): GroupToolPolicyConfig | undefined;
export declare function resolveChannelGroupPolicy(params: {
    cfg: OpenClawConfig;
    channel: GroupPolicyChannel;
    groupId?: string | null;
    accountId?: string | null;
    groupIdCaseInsensitive?: boolean;
    /** When true, sender-level filtering (groupAllowFrom) is configured upstream. */
    hasGroupAllowFrom?: boolean;
}): ChannelGroupPolicy;
export declare function resolveChannelGroupRequireMention(params: {
    cfg: OpenClawConfig;
    channel: GroupPolicyChannel;
    groupId?: string | null;
    accountId?: string | null;
    groupIdCaseInsensitive?: boolean;
    requireMentionOverride?: boolean;
    overrideOrder?: "before-config" | "after-config";
}): boolean;
export declare function resolveChannelGroupToolsPolicy(params: {
    cfg: OpenClawConfig;
    channel: GroupPolicyChannel;
    groupId?: string | null;
    accountId?: string | null;
    groupIdCaseInsensitive?: boolean;
} & GroupToolPolicySender): GroupToolPolicyConfig | undefined;

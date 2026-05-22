import type { ChannelId } from "../channels/plugins/channel-id.types.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { type GroupToolPolicyBySenderConfig, type GroupToolPolicyConfig } from "./types.tools.js";
type GroupPolicyChannel = ChannelId;
type ChannelGroupConfig = {
    requireMention?: boolean;
    ingest?: boolean;
    tools?: GroupToolPolicyConfig;
    toolsBySender?: GroupToolPolicyBySenderConfig;
};
export type ChannelGroupPolicy = {
    allowlistEnabled: boolean;
    allowed: boolean;
    groupConfig?: ChannelGroupConfig;
    defaultConfig?: ChannelGroupConfig;
};
type GroupToolPolicySender = {
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
    configuredGroupDefaultsToNoMention?: boolean;
    overrideOrder?: "before-config" | "after-config";
}): boolean;
export declare function resolveChannelGroupToolsPolicy(params: {
    cfg: OpenClawConfig;
    channel: GroupPolicyChannel;
    groupId?: string | null;
    groupIdCandidates?: Array<string | null | undefined>;
    accountId?: string | null;
    groupIdCaseInsensitive?: boolean;
} & GroupToolPolicySender): GroupToolPolicyConfig | undefined;
export {};

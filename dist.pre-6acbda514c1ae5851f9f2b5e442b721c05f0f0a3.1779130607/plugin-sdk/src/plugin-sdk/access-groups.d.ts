import { ACCESS_GROUP_ALLOW_FROM_PREFIX, parseAccessGroupAllowFromEntry } from "../channels/allow-from.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { AccessGroupConfig } from "../config/types.access-groups.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export { ACCESS_GROUP_ALLOW_FROM_PREFIX, parseAccessGroupAllowFromEntry };
export type AccessGroupMembershipResolver = (params: {
    cfg: OpenClawConfig;
    name: string;
    group: AccessGroupConfig;
    channel: ChannelId;
    accountId: string;
    senderId: string;
}) => boolean | Promise<boolean>;
export type AccessGroupMembershipLookup = (params: {
    name: string;
    group: AccessGroupConfig;
    channel: ChannelId;
    accountId: string;
    senderId: string;
}) => boolean | Promise<boolean>;
export type ResolvedAccessGroupAllowFromState = {
    referenced: string[];
    matched: string[];
    missing: string[];
    unsupported: string[];
    failed: string[];
    matchedAllowFromEntries: string[];
    hasReferences: boolean;
    hasMatch: boolean;
};
export declare function resolveAccessGroupAllowFromState(params: {
    accessGroups?: Record<string, AccessGroupConfig>;
    allowFrom: Array<string | number> | null | undefined;
    channel: ChannelId;
    accountId: string;
    senderId: string;
    isSenderAllowed?: (senderId: string, allowFrom: string[]) => boolean;
    resolveMembership?: AccessGroupMembershipLookup;
}): Promise<ResolvedAccessGroupAllowFromState>;
export declare function resolveAccessGroupAllowFromMatches(params: {
    cfg?: OpenClawConfig;
    allowFrom: Array<string | number> | null | undefined;
    channel: ChannelId;
    accountId: string;
    senderId: string;
    isSenderAllowed?: (senderId: string, allowFrom: string[]) => boolean;
    resolveMembership?: AccessGroupMembershipResolver;
}): Promise<string[]>;
export declare function expandAllowFromWithAccessGroups(params: {
    cfg?: OpenClawConfig;
    allowFrom: Array<string | number> | null | undefined;
    channel: ChannelId;
    accountId: string;
    senderId: string;
    senderAllowEntry?: string;
    isSenderAllowed?: (senderId: string, allowFrom: string[]) => boolean;
    resolveMembership?: AccessGroupMembershipResolver;
}): Promise<string[]>;

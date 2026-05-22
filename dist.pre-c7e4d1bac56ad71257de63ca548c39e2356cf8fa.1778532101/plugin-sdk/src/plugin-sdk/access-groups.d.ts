import type { ChannelId } from "../channels/plugins/types.public.js";
import type { AccessGroupConfig } from "../config/types.access-groups.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare const ACCESS_GROUP_ALLOW_FROM_PREFIX = "accessGroup:";
export type AccessGroupMembershipResolver = (params: {
    cfg: OpenClawConfig;
    name: string;
    group: AccessGroupConfig;
    channel: ChannelId;
    accountId: string;
    senderId: string;
}) => boolean | Promise<boolean>;
export declare function parseAccessGroupAllowFromEntry(entry: string): string | null;
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

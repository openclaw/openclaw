import { Et as AccessGroupConfig, i as OpenClawConfig } from "./types.openclaw-CoVv5VQR.js";
import { t as ChannelId } from "./channel-id.types-_c58kC27.js";
//#region src/plugin-sdk/access-groups.d.ts
declare const ACCESS_GROUP_ALLOW_FROM_PREFIX = "accessGroup:";
type AccessGroupMembershipResolver = (params: {
  cfg: OpenClawConfig;
  name: string;
  group: AccessGroupConfig;
  channel: ChannelId;
  accountId: string;
  senderId: string;
}) => boolean | Promise<boolean>;
declare function parseAccessGroupAllowFromEntry(entry: string): string | null;
declare function resolveAccessGroupAllowFromMatches(params: {
  cfg?: OpenClawConfig;
  allowFrom: Array<string | number> | null | undefined;
  channel: ChannelId;
  accountId: string;
  senderId: string;
  isSenderAllowed?: (senderId: string, allowFrom: string[]) => boolean;
  resolveMembership?: AccessGroupMembershipResolver;
}): Promise<string[]>;
declare function expandAllowFromWithAccessGroups(params: {
  cfg?: OpenClawConfig;
  allowFrom: Array<string | number> | null | undefined;
  channel: ChannelId;
  accountId: string;
  senderId: string;
  senderAllowEntry?: string;
  isSenderAllowed?: (senderId: string, allowFrom: string[]) => boolean;
  resolveMembership?: AccessGroupMembershipResolver;
}): Promise<string[]>;
//#endregion
export { resolveAccessGroupAllowFromMatches as a, parseAccessGroupAllowFromEntry as i, AccessGroupMembershipResolver as n, expandAllowFromWithAccessGroups as r, ACCESS_GROUP_ALLOW_FROM_PREFIX as t };
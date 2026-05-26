import { i as OpenClawConfig, jt as AccessGroupConfig } from "./types.openclaw-BLF4DJTX.js";
import { t as ChannelId } from "./channel-id.types-ClK6B_QE.js";
//#region src/plugin-sdk/access-groups.d.ts
type AccessGroupMembershipResolver = (params: {
  cfg: OpenClawConfig;
  name: string;
  group: AccessGroupConfig;
  channel: ChannelId;
  accountId: string;
  senderId: string;
}) => boolean | Promise<boolean>;
type AccessGroupMembershipLookup = (params: {
  name: string;
  group: AccessGroupConfig;
  channel: ChannelId;
  accountId: string;
  senderId: string;
}) => boolean | Promise<boolean>;
type ResolvedAccessGroupAllowFromState = {
  referenced: string[];
  matched: string[];
  missing: string[];
  unsupported: string[];
  failed: string[];
  matchedAllowFromEntries: string[];
  hasReferences: boolean;
  hasMatch: boolean;
};
declare function resolveAccessGroupAllowFromState(params: {
  accessGroups?: Record<string, AccessGroupConfig>;
  allowFrom: Array<string | number> | null | undefined;
  channel: ChannelId;
  accountId: string;
  senderId: string;
  isSenderAllowed?: (senderId: string, allowFrom: string[]) => boolean;
  resolveMembership?: AccessGroupMembershipLookup;
}): Promise<ResolvedAccessGroupAllowFromState>;
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
export { resolveAccessGroupAllowFromMatches as a, expandAllowFromWithAccessGroups as i, AccessGroupMembershipResolver as n, resolveAccessGroupAllowFromState as o, ResolvedAccessGroupAllowFromState as r, AccessGroupMembershipLookup as t };
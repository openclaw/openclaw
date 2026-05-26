import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { a as GroupToolPolicyBySenderConfig, o as GroupToolPolicyConfig } from "./types.tools-BpgZArJS.js";
import { t as ChannelId } from "./channel-id.types-ClK6B_QE.js";

//#region src/config/group-policy.d.ts
type GroupPolicyChannel = ChannelId;
type ChannelGroupConfig = {
  requireMention?: boolean;
  ingest?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
};
type ChannelGroupPolicy = {
  allowlistEnabled: boolean;
  allowed: boolean;
  groupConfig?: ChannelGroupConfig;
  defaultConfig?: ChannelGroupConfig;
};
type GroupToolPolicySender = {
  messageProvider?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
};
declare function resolveToolsBySender(params: {
  toolsBySender?: GroupToolPolicyBySenderConfig;
} & GroupToolPolicySender): GroupToolPolicyConfig | undefined;
declare function resolveChannelGroupPolicy(params: {
  cfg: OpenClawConfig;
  channel: GroupPolicyChannel;
  groupId?: string | null;
  accountId?: string | null;
  groupIdCaseInsensitive?: boolean; /** When true, sender-level filtering (groupAllowFrom) is configured upstream. */
  hasGroupAllowFrom?: boolean;
}): ChannelGroupPolicy;
declare function resolveChannelGroupRequireMention(params: {
  cfg: OpenClawConfig;
  channel: GroupPolicyChannel;
  groupId?: string | null;
  accountId?: string | null;
  groupIdCaseInsensitive?: boolean;
  requireMentionOverride?: boolean;
  configuredGroupDefaultsToNoMention?: boolean;
  overrideOrder?: "before-config" | "after-config";
}): boolean;
declare function resolveChannelGroupToolsPolicy(params: {
  cfg: OpenClawConfig;
  channel: GroupPolicyChannel;
  groupId?: string | null;
  groupIdCandidates?: Array<string | null | undefined>;
  accountId?: string | null;
  groupIdCaseInsensitive?: boolean;
} & GroupToolPolicySender): GroupToolPolicyConfig | undefined;
//#endregion
export { resolveToolsBySender as a, resolveChannelGroupToolsPolicy as i, resolveChannelGroupPolicy as n, resolveChannelGroupRequireMention as r, ChannelGroupPolicy as t };
import { i as OpenClawConfig } from "./types.openclaw-CoVv5VQR.js";
import { _ as GroupPolicy, h as DmPolicy } from "./types.base-CN1BlTRP.js";
import { t as ChannelGroupPolicy } from "./group-policy-BXU9JzCr.js";
import { n as ResolvedWhatsAppAccount } from "./accounts-B-zgNSmt.js";
//#region extensions/whatsapp/src/inbound-policy.d.ts
type ResolvedWhatsAppInboundPolicy = {
  account: ResolvedWhatsAppAccount;
  dmPolicy: DmPolicy;
  groupPolicy: GroupPolicy;
  configuredAllowFrom: string[];
  dmAllowFrom: string[];
  groupAllowFrom: string[];
  isSelfChat: boolean;
  providerMissingFallbackApplied: boolean;
  shouldReadStorePairingApprovals: boolean;
  isSamePhone: (value?: string | null) => boolean;
  isDmSenderAllowed: (allowEntries: string[], sender?: string | null) => boolean;
  isGroupSenderAllowed: (allowEntries: string[], sender?: string | null) => boolean;
  resolveConversationGroupPolicy: (conversationId: string) => ChannelGroupPolicy;
  resolveConversationRequireMention: (conversationId: string) => boolean;
};
declare function resolveWhatsAppInboundPolicy(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  selfE164?: string | null;
}): ResolvedWhatsAppInboundPolicy;
//#endregion
export { resolveWhatsAppInboundPolicy as t };
import { i as OpenClawConfig } from "./types.openclaw-BdSNxnBz.js";
import { _ as GroupPolicy, h as DmPolicy } from "./types.base-DugutrX1.js";
import { t as ChannelGroupPolicy } from "./group-policy-CZfYRI_m.js";
import { n as ResolvedWhatsAppAccount } from "./accounts-BpYV83dd.js";
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
  isSamePhone: (value?: string | null) => boolean;
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
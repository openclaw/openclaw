import { i as OpenClawConfig } from "./types.openclaw-BdZr8Ncl.js";
import { _ as GroupPolicy, h as DmPolicy } from "./types.base-BUAA7yMj.js";
import { t as ChannelGroupPolicy } from "./group-policy-BoWG_ugi.js";
import { n as ResolvedWhatsAppAccount } from "./accounts-DXrv9ias.js";
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
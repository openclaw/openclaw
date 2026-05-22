import { l as normalizeE164, p as resolveUserPath } from "../../utils-DqKz1rhL.js";
import { n as ChannelPlugin } from "../../types.public-D-nwYThg.js";
import { a as listWhatsAppAuthDirs, c as resolveWhatsAppMediaMaxBytes, i as listEnabledWhatsAppAccounts, l as listAccountIds, n as ResolvedWhatsAppAccount, o as resolveWhatsAppAccount, r as hasAnyWhatsAppAuth, s as resolveWhatsAppAuthDir, t as DEFAULT_WHATSAPP_MEDIA_MAX_MB, u as resolveDefaultWhatsAppAccountId } from "../../accounts-BpYV83dd.js";
import { t as whatsappPlugin } from "../../channel-Djm5alGX.js";
import { t as whatsappSetupPlugin } from "../../channel.setup-C0jpSYCN.js";
import { t as DEFAULT_WEB_MEDIA_BYTES } from "../../constants-Bm1G8HGN.js";
import { a as resolveWhatsAppOutboundTarget, c as WebInboundMsg, d as resolveWhatsAppGroupToolPolicy, l as WebMonitorTuning, o as WebChannelHealthState, s as WebChannelStatus, t as resolveWhatsAppGroupIntroHint, u as resolveWhatsAppGroupRequireMention } from "../../runtime-api-DJcjBKkR.js";
import { A as isSelfChatMode, D as JidToE164Options, F as toWhatsappJidWithLid, M as markdownToWhatsApp, N as resolveJidToE164, O as WebChannel, P as toWhatsappJid, j as jidToE164, k as assertWebChannel } from "../../session-errors-CmUu4pds.js";
import { a as WhatsAppStructuredContactContext, i as WebListenerCloseReason, n as ActiveWebSendOptions, r as WebInboundMessage, t as ActiveWebListener } from "../../types-C0L16Ykr.js";
import { n as listWhatsAppDirectoryPeersFromConfig, t as listWhatsAppDirectoryGroupsFromConfig } from "../../directory-config-BQa61GNG.js";
import { a as normalizeWhatsAppMessagingTarget, i as normalizeWhatsAppAllowFromEntries, n as isWhatsAppUserTarget, o as normalizeWhatsAppTarget, r as looksLikeWhatsAppTargetId, t as isWhatsAppGroupJid } from "../../normalize-target-CPXdm1U4.js";
import { t as resolveWhatsAppInboundPolicy } from "../../inbound-policy-BtWBONJm.js";

//#region extensions/whatsapp/src/command-policy.d.ts
declare const whatsappCommandPolicy: NonNullable<ChannelPlugin["commands"]>;
//#endregion
//#region extensions/whatsapp/src/outbound-send-deps.d.ts
declare const WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS: readonly ["sendWhatsApp"];
//#endregion
//#region extensions/whatsapp/src/inbound/access-control.d.ts
declare const __testing: {
  resolveWhatsAppInboundPolicy: typeof resolveWhatsAppInboundPolicy;
};
//#endregion
//#region extensions/whatsapp/src/qa-driver.runtime.d.ts
type WhatsAppQaDriverObservedMessage = {
  fromJid?: string;
  fromPhoneE164?: string | null;
  messageId?: string;
  observedAt: string;
  text: string;
};
type WhatsAppQaDriverSession = {
  close: () => Promise<void>;
  getObservedMessages: () => WhatsAppQaDriverObservedMessage[];
  sendText: (to: string, text: string) => Promise<{
    messageId?: string;
  }>;
  waitForMessage: (params: {
    match: (message: WhatsAppQaDriverObservedMessage) => boolean;
    timeoutMs: number;
  }) => Promise<WhatsAppQaDriverObservedMessage>;
};
declare function startWhatsAppQaDriverSession(params: {
  authDir: string;
  connectionTimeoutMs?: number;
}): Promise<WhatsAppQaDriverSession>;
//#endregion
export { type ActiveWebListener, type ActiveWebSendOptions, DEFAULT_WEB_MEDIA_BYTES, DEFAULT_WHATSAPP_MEDIA_MAX_MB, type JidToE164Options, type ResolvedWhatsAppAccount, WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS, type WebChannel, type WebChannelHealthState, type WebChannelStatus, type WebInboundMessage, type WebInboundMsg, type WebListenerCloseReason, type WebMonitorTuning, type WhatsAppQaDriverObservedMessage, type WhatsAppQaDriverSession, type WhatsAppStructuredContactContext, assertWebChannel, hasAnyWhatsAppAuth, isSelfChatMode, isWhatsAppGroupJid, isWhatsAppUserTarget, jidToE164, listEnabledWhatsAppAccounts, listAccountIds as listWhatsAppAccountIds, listWhatsAppAuthDirs, listWhatsAppDirectoryGroupsFromConfig, listWhatsAppDirectoryPeersFromConfig, looksLikeWhatsAppTargetId, markdownToWhatsApp, normalizeE164, normalizeWhatsAppAllowFromEntries, normalizeWhatsAppMessagingTarget, normalizeWhatsAppTarget, resolveDefaultWhatsAppAccountId, resolveJidToE164, resolveUserPath, resolveWhatsAppAccount, resolveWhatsAppAuthDir, resolveWhatsAppGroupIntroHint, resolveWhatsAppGroupRequireMention, resolveWhatsAppGroupToolPolicy, resolveWhatsAppMediaMaxBytes, resolveWhatsAppOutboundTarget, startWhatsAppQaDriverSession, toWhatsappJid, toWhatsappJidWithLid, __testing as whatsappAccessControlTesting, whatsappCommandPolicy, whatsappPlugin, whatsappSetupPlugin };
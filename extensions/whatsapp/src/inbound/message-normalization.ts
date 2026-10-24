import type { WAMessage } from "baileys";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { upsertChannelPairingRequest } from "openclaw/plugin-sdk/conversation-runtime";
import { warnMissingProviderGroupPolicyFallbackOnce } from "openclaw/plugin-sdk/runtime-group-policy";
import { logWhatsAppVerbose } from "../auto-reply/loggers.js";
import { resolveWhatsAppInboundPolicy, resolveWhatsAppIngressAccess } from "../inbound-policy.js";
import { buildWhatsAppInboundAdmission } from "./admission.js";
import { isRecentOutboundMessage } from "./dedupe.js";
import { hasInboundUserContent } from "./extract.js";
import type { WhatsAppGroupMetadataCacheOwner } from "./group-metadata-cache.js";
import { isJidGroup } from "./runtime-api.js";
import type { WhatsAppAttachedSocketSession } from "./socket-session.js";

const PAIRING_REPLY_HISTORY_GRACE_MS = 30_000;

export type WhatsAppNormalizedInboundMessage = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createWhatsAppInboundMessageNormalizer>["normalize"]>>
>;

export function createWhatsAppInboundMessageNormalizer(options: {
  cfg: OpenClawConfig;
  loadConfig?: () => OpenClawConfig;
  accountId: string;
  verbose: boolean;
  socketSession: WhatsAppAttachedSocketSession;
  groupMetadata: WhatsAppGroupMetadataCacheOwner;
  parseTimestampSeconds: (value: unknown) => number | undefined;
}) {
  const { socketSession, groupMetadata } = options;
  const shouldSkipRecentOutboundEcho = (msg: WAMessage): boolean => {
    const id = msg.key?.id ?? undefined;
    const remoteJid = msg.key?.remoteJid;
    if (
      !msg.key?.fromMe ||
      !id ||
      !remoteJid ||
      !isRecentOutboundMessage({
        accountId: options.accountId,
        remoteJid,
        alternateRemoteJid: msg.key?.remoteJidAlt,
        messageId: id,
      })
    ) {
      return false;
    }
    return true;
  };

  const normalize = async (msg: WAMessage) => {
    const id = msg.key?.id ?? undefined;
    const remoteJid = msg.key?.remoteJid;
    if (!remoteJid || remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast")) {
      return null;
    }

    const group = isJidGroup(remoteJid) === true;
    // Gateway-originated echoes must never become new inbound work, including
    // self-chat replies that return on the same upsert stream.
    if (shouldSkipRecentOutboundEcho(msg)) {
      return null;
    }
    // Receipts, presence, and protocol messages share the upsert stream. Gate
    // access control on actual user content to avoid unsolicited pairing replies.
    if (!hasInboundUserContent(msg.message ?? undefined)) {
      return null;
    }

    const participantJid = msg.key?.participant ?? undefined;
    const from = group ? remoteJid : await socketSession.resolveInboundJid(remoteJid);
    if (!from) {
      return null;
    }
    const senderE164 = group
      ? participantJid
        ? await socketSession.resolveInboundJid(participantJid)
        : null
      : from;

    let groupSubject: string | undefined;
    let groupParticipants: string[] | undefined;
    if (group) {
      const meta = await groupMetadata.get(remoteJid);
      groupSubject = meta.subject;
      groupParticipants = meta.participants;
    }
    const messageTimestampSeconds = options.parseTimestampSeconds(msg.messageTimestamp);
    const messageTimestampMs =
      messageTimestampSeconds !== undefined ? messageTimestampSeconds * 1000 : undefined;
    const cfg = options.loadConfig?.() ?? options.cfg;
    const selfE164 = socketSession.self.e164 ?? null;
    const isFromMe = Boolean(msg.key?.fromMe);
    const connectedAtMs = socketSession.connectedAtMs;
    const policy = resolveWhatsAppInboundPolicy({
      cfg,
      accountId: options.accountId,
      selfE164,
    });
    const suppressPairingReply =
      messageTimestampMs !== undefined &&
      messageTimestampMs < connectedAtMs - PAIRING_REPLY_HISTORY_GRACE_MS;

    warnMissingProviderGroupPolicyFallbackOnce({
      providerMissingFallbackApplied: policy.providerMissingFallbackApplied,
      providerKey: "whatsapp",
      accountId: policy.account.accountId,
      log: (message) => logWhatsAppVerbose(options.verbose, message),
    });
    const conversationId = group ? remoteJid : from;
    const accessSenderId = group ? senderE164 : from;
    const admissionSenderId = group ? (senderE164 ?? participantJid ?? from) : from;
    const resolveChannelIngress = async (
      contextBinding?: import("openclaw/plugin-sdk/channel-ingress-runtime").ChannelIngressContextBinding,
    ) =>
      await resolveWhatsAppIngressAccess({
        cfg,
        policy,
        isGroup: group,
        conversationId,
        senderId: accessSenderId,
        contextBinding,
      });
    const ingressAccess = await resolveChannelIngress();
    const { senderAccess } = ingressAccess;
    if (group && senderAccess.decision !== "allow") {
      if (senderAccess.reasonCode === "group_policy_disabled") {
        logWhatsAppVerbose(options.verbose, "Blocked group message (groupPolicy: disabled)");
      } else if (senderAccess.reasonCode === "group_policy_empty_allowlist") {
        logWhatsAppVerbose(
          options.verbose,
          "Blocked group message (groupPolicy: allowlist, no groupAllowFrom)",
        );
      } else {
        logWhatsAppVerbose(
          options.verbose,
          `Blocked group message from ${senderE164 ?? "unknown sender"} (groupPolicy: allowlist)`,
        );
      }
      return null;
    }

    if (!group) {
      if (isFromMe && (policy.account.selfChatMode === false || !policy.isSamePhone(from))) {
        logWhatsAppVerbose(
          options.verbose,
          "Skipping outbound DM (fromMe); no pairing reply needed.",
        );
        return null;
      }
      if (senderAccess.decision === "block" && senderAccess.reasonCode === "dm_policy_disabled") {
        logWhatsAppVerbose(options.verbose, "Blocked dm (dmPolicy: disabled)");
        return null;
      }
      if (senderAccess.decision === "pairing" && !policy.isSamePhone(from)) {
        const candidate = from;
        if (suppressPairingReply) {
          logWhatsAppVerbose(
            options.verbose,
            `Skipping pairing reply for historical DM from ${candidate}.`,
          );
        } else {
          await createChannelPairingChallengeIssuer({
            channel: "whatsapp",
            accountId: policy.account.accountId,
            upsertPairingRequest: async ({ id: pairingId, meta }) =>
              await upsertChannelPairingRequest({
                channel: "whatsapp",
                id: pairingId,
                accountId: policy.account.accountId,
                meta,
              }),
          })({
            senderId: candidate,
            senderIdLine: `Your WhatsApp phone number: ${candidate}`,
            meta: { name: (msg.pushName ?? "").trim() || undefined },
            onCreated: () => {
              logWhatsAppVerbose(
                options.verbose,
                `whatsapp pairing request sender=${candidate} name=${msg.pushName ?? "unknown"}`,
              );
            },
            sendPairingReply: async (text) => {
              await socketSession.sendTrackedMessage(remoteJid, { text });
            },
            onReplyError: (err) => {
              logWhatsAppVerbose(
                options.verbose,
                `whatsapp pairing reply failed for ${candidate}: ${String(err)}`,
              );
            },
          });
        }
        return null;
      }
      if (senderAccess.decision !== "allow") {
        logWhatsAppVerbose(
          options.verbose,
          `Blocked unauthorized sender ${from} (dmPolicy=${policy.dmPolicy})`,
        );
        return null;
      }
    }

    const access = {
      isSelfChat: policy.isSelfChat,
      admission: buildWhatsAppInboundAdmission({
        policy,
        access: ingressAccess,
        channelIngress: ingressAccess,
        resolveChannelIngress,
        isGroup: group,
        conversationId,
        senderId: admissionSenderId,
      }),
    };

    return {
      id,
      remoteJid,
      group,
      participantJid,
      from,
      senderE164,
      groupSubject,
      groupParticipants,
      messageTimestampMs,
      access,
    };
  };

  return { normalize, shouldSkipRecentOutboundEcho } as const;
}

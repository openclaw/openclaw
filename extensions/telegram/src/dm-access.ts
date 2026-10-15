import type { Bot } from "grammy";
import type { Message } from "grammy/types";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import type { DmPolicy } from "openclaw/plugin-sdk/config-contracts";
import { upsertChannelPairingRequest } from "openclaw/plugin-sdk/conversation-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import type { NormalizedAllowFrom } from "./bot-access.js";
import type { TelegramLogger } from "./bot-message-context.types.js";
import { renderTelegramHtmlText } from "./format.js";
import { createTelegramIngressResolver, telegramAllowEntries } from "./ingress.js";

function resolveTelegramSenderIdentity(msg: Message, chatId: number) {
  const from = msg.from;
  const userId = from?.id != null ? String(from.id) : null;
  return {
    username: from?.username ?? "",
    userId,
    candidateId: userId ?? String(chatId),
    firstName: from?.first_name,
    lastName: from?.last_name,
  };
}

async function decideTelegramDmAccess(
  params: { accountId: string; dmPolicy: DmPolicy; effectiveDmAllow: NormalizedAllowFrom },
  candidateId: string,
) {
  const result = await createTelegramIngressResolver({ accountId: params.accountId }).message({
    subject: { stableId: candidateId },
    conversation: {
      kind: "direct",
      id: candidateId,
    },
    dmPolicy: params.dmPolicy,
    groupPolicy: "disabled",
    allowFrom: telegramAllowEntries(params.effectiveDmAllow),
  });
  return result.ingress;
}

export async function isTelegramDmAccessAllowed(params: {
  dmPolicy: DmPolicy;
  msg: Message;
  chatId: number;
  effectiveDmAllow: NormalizedAllowFrom;
  accountId: string;
}): Promise<boolean> {
  if (params.dmPolicy === "disabled") {
    return false;
  }
  const sender = resolveTelegramSenderIdentity(params.msg, params.chatId);
  const access = await decideTelegramDmAccess(params, sender.candidateId);
  return access.decision === "allow";
}

export async function enforceTelegramDmAccess(params: {
  isGroup: boolean;
  dmPolicy: DmPolicy;
  msg: Message;
  chatId: number;
  effectiveDmAllow: NormalizedAllowFrom;
  accountId: string;
  bot: Bot;
  logger: TelegramLogger;
  upsertPairingRequest?: typeof upsertChannelPairingRequest;
}): Promise<boolean> {
  const { isGroup, dmPolicy, msg, chatId, accountId, bot, logger, upsertPairingRequest } = params;
  if (isGroup) {
    return true;
  }
  if (dmPolicy === "disabled") {
    return false;
  }

  const sender = resolveTelegramSenderIdentity(msg, chatId);
  const access = await decideTelegramDmAccess(params, sender.candidateId);
  if (access.decision === "allow") {
    return true;
  }

  if (dmPolicy === "open") {
    logVerbose(`Blocked unauthorized telegram sender ${sender.candidateId} (dmPolicy=open)`);
    return false;
  }

  if (access.decision === "pairing") {
    try {
      await createChannelPairingChallengeIssuer({
        channel: "telegram",
        accountId,
        upsertPairingRequest: async ({ id, meta }) =>
          await (upsertPairingRequest ?? upsertChannelPairingRequest)({
            channel: "telegram",
            id,
            accountId,
            meta,
          }),
      })({
        senderId: sender.candidateId,
        senderIdLine: `Your Telegram user id: ${sender.candidateId}`,
        meta: {
          username: sender.username || undefined,
          firstName: sender.firstName,
          lastName: sender.lastName,
        },
        onCreated: () => {
          logger.info(
            {
              chatId: String(chatId),
              senderUserId: sender.userId ?? undefined,
              username: sender.username || undefined,
              firstName: sender.firstName,
              lastName: sender.lastName,
            },
            "telegram pairing request",
          );
        },
        sendPairingReply: async (text) => {
          const html = renderTelegramHtmlText(text);
          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            fn: () => bot.api.sendMessage(chatId, html, { parse_mode: "HTML" }),
          });
        },
        onReplyError: (err) => {
          logVerbose(`telegram pairing reply failed for chat ${chatId}: ${String(err)}`);
        },
      });
    } catch (err) {
      logVerbose(`telegram pairing reply failed for chat ${chatId}: ${String(err)}`);
    }
    return false;
  }

  logVerbose(`Blocked unauthorized telegram sender ${sender.candidateId} (dmPolicy=${dmPolicy})`);
  return false;
}

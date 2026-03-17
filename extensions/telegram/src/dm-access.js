import { logVerbose } from "../../../src/globals.js";
import { issuePairingChallenge } from "../../../src/pairing/pairing-challenge.js";
import { upsertChannelPairingRequest } from "../../../src/pairing/pairing-store.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { resolveSenderAllowMatch } from "./bot-access.js";
function resolveTelegramSenderIdentity(msg, chatId) {
  const from = msg.from;
  const userId = from?.id != null ? String(from.id) : null;
  return {
    username: from?.username ?? "",
    userId,
    candidateId: userId ?? String(chatId),
    firstName: from?.first_name,
    lastName: from?.last_name
  };
}
async function enforceTelegramDmAccess(params) {
  const { isGroup, dmPolicy, msg, chatId, effectiveDmAllow, accountId, bot, logger } = params;
  if (isGroup) {
    return true;
  }
  if (dmPolicy === "disabled") {
    return false;
  }
  if (dmPolicy === "open") {
    return true;
  }
  const sender = resolveTelegramSenderIdentity(msg, chatId);
  const allowMatch = resolveSenderAllowMatch({
    allow: effectiveDmAllow,
    senderId: sender.candidateId,
    senderUsername: sender.username
  });
  const allowMatchMeta = `matchKey=${allowMatch.matchKey ?? "none"} matchSource=${allowMatch.matchSource ?? "none"}`;
  const allowed = effectiveDmAllow.hasWildcard || effectiveDmAllow.hasEntries && allowMatch.allowed;
  if (allowed) {
    return true;
  }
  if (dmPolicy === "pairing") {
    try {
      const telegramUserId = sender.userId ?? sender.candidateId;
      await issuePairingChallenge({
        channel: "telegram",
        senderId: telegramUserId,
        senderIdLine: `Your Telegram user id: ${telegramUserId}`,
        meta: {
          username: sender.username || void 0,
          firstName: sender.firstName,
          lastName: sender.lastName
        },
        upsertPairingRequest: async ({ id, meta }) => await upsertChannelPairingRequest({
          channel: "telegram",
          id,
          accountId,
          meta
        }),
        onCreated: () => {
          logger.info(
            {
              chatId: String(chatId),
              senderUserId: sender.userId ?? void 0,
              username: sender.username || void 0,
              firstName: sender.firstName,
              lastName: sender.lastName,
              matchKey: allowMatch.matchKey ?? "none",
              matchSource: allowMatch.matchSource ?? "none"
            },
            "telegram pairing request"
          );
        },
        sendPairingReply: async (text) => {
          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            fn: () => bot.api.sendMessage(chatId, text)
          });
        },
        onReplyError: (err) => {
          logVerbose(`telegram pairing reply failed for chat ${chatId}: ${String(err)}`);
        }
      });
    } catch (err) {
      logVerbose(`telegram pairing reply failed for chat ${chatId}: ${String(err)}`);
    }
    return false;
  }
  logVerbose(
    `Blocked unauthorized telegram sender ${sender.candidateId} (dmPolicy=${dmPolicy}, ${allowMatchMeta})`
  );
  return false;
}
export {
  enforceTelegramDmAccess
};

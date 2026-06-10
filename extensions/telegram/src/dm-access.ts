// Telegram plugin module implements dm access behavior.
import type { Bot } from "grammy";
import type { Message } from "grammy/types";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import type { DmPolicy } from "openclaw/plugin-sdk/config-contracts";
import { upsertChannelPairingRequest } from "openclaw/plugin-sdk/conversation-runtime";
import {
  createInternalHookEvent,
  deriveInboundMessageHookContext,
  fireAndForgetBoundedHook,
  toInternalMessagePreAuthContext,
  toPluginMessageContext,
  toPluginMessagePreAuthEvent,
  triggerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import type { NormalizedAllowFrom } from "./bot-access.js";
import { getTelegramTextParts, renderTelegramTextEntities } from "./bot/body-helpers.js";
import { renderTelegramHtmlText } from "./format.js";
import {
  createTelegramIngressSubject,
  createTelegramIngressResolver,
  telegramAllowEntries,
} from "./ingress.js";

type TelegramDmAccessLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
};
type MessagePreAuthHookRunner = Pick<
  NonNullable<ReturnType<typeof getGlobalHookRunner>>,
  "hasHooks" | "runMessagePreAuth"
>;

type TelegramSenderIdentity = {
  username: string;
  userId: string | null;
  candidateId: string;
  firstName?: string;
  lastName?: string;
};

const TELEGRAM_MESSAGE_PRE_AUTH_HOOK_LIMITS = {
  maxConcurrency: 8,
  maxQueue: 128,
  timeoutMs: 2_000,
};

function resolveTelegramSenderIdentity(msg: Message, chatId: number): TelegramSenderIdentity {
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

async function decideTelegramDmAccess(params: {
  accountId: string;
  dmPolicy: DmPolicy;
  sender: TelegramSenderIdentity;
  effectiveDmAllow: NormalizedAllowFrom;
}) {
  const result = await createTelegramIngressResolver({ accountId: params.accountId }).message({
    subject: createTelegramIngressSubject(params.sender.candidateId),
    conversation: {
      kind: "direct",
      id: params.sender.candidateId,
    },
    dmPolicy: params.dmPolicy,
    groupPolicy: "disabled",
    allowFrom: telegramAllowEntries(params.effectiveDmAllow),
  });
  return result.ingress;
}

function resolveTelegramPreAuthContent(msg: Message): string {
  const textParts = getTelegramTextParts(msg);
  return renderTelegramTextEntities(textParts.text, textParts.entities).trim();
}

export function emitTelegramMessagePreAuthHooks(params: {
  accountId: string;
  chatId: number;
  sender: TelegramSenderIdentity;
  content: string;
  messageId?: number;
  messageTimestampMs?: number;
  hookRunner?: MessagePreAuthHookRunner | null;
}): void {
  const from = `telegram:${params.sender.candidateId}`;
  const to = `telegram:${params.chatId}`;
  const senderName =
    [params.sender.firstName, params.sender.lastName].filter(Boolean).join(" ").trim() ||
    params.sender.username ||
    undefined;
  const canonical = deriveInboundMessageHookContext({
    From: from,
    To: to,
    Body: params.content,
    RawBody: params.content,
    BodyForCommands: params.content,
    Timestamp: params.messageTimestampMs,
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: to,
    AccountId: params.accountId,
    SenderId: params.sender.userId ?? params.sender.candidateId,
    SenderName: senderName,
    SenderUsername: params.sender.username || undefined,
    MessageSid: params.messageId != null ? String(params.messageId) : undefined,
    CommandAuthorized: false,
  });
  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  if (hookRunner?.hasHooks("message_pre_auth")) {
    fireAndForgetBoundedHook(
      () =>
        hookRunner.runMessagePreAuth(
          toPluginMessagePreAuthEvent(canonical),
          toPluginMessageContext(canonical),
        ),
      "telegram: message_pre_auth plugin hook failed",
      undefined,
      TELEGRAM_MESSAGE_PRE_AUTH_HOOK_LIMITS,
    );
  }
  fireAndForgetBoundedHook(
    () =>
      triggerInternalHook(
        createInternalHookEvent(
          "message",
          "pre-auth",
          "",
          toInternalMessagePreAuthContext(canonical),
        ),
      ),
    "telegram: message_pre_auth internal hook failed",
    undefined,
    TELEGRAM_MESSAGE_PRE_AUTH_HOOK_LIMITS,
  );
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
  const access = await decideTelegramDmAccess({
    accountId: params.accountId,
    dmPolicy: params.dmPolicy,
    sender,
    effectiveDmAllow: params.effectiveDmAllow,
  });
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
  logger: TelegramDmAccessLogger;
  upsertPairingRequest?: typeof upsertChannelPairingRequest;
  messagePreAuthHookRunner?: MessagePreAuthHookRunner | null;
}): Promise<boolean> {
  const {
    isGroup,
    dmPolicy,
    msg,
    chatId,
    effectiveDmAllow,
    accountId,
    bot,
    logger,
    upsertPairingRequest,
  } = params;
  if (isGroup) {
    return true;
  }
  if (dmPolicy === "disabled") {
    return false;
  }

  const sender = resolveTelegramSenderIdentity(msg, chatId);
  const access = await decideTelegramDmAccess({
    accountId,
    dmPolicy,
    sender,
    effectiveDmAllow,
  });
  if (access.decision === "allow") {
    return true;
  }
  emitTelegramMessagePreAuthHooks({
    accountId,
    chatId,
    sender,
    content: resolveTelegramPreAuthContent(msg),
    messageId: typeof msg.message_id === "number" ? msg.message_id : undefined,
    messageTimestampMs: msg.date ? msg.date * 1000 : undefined,
    hookRunner: params.messagePreAuthHookRunner,
  });

  if (dmPolicy === "open") {
    logVerbose(`Blocked unauthorized telegram sender ${sender.candidateId} (dmPolicy=open)`);
    return false;
  }

  if (access.decision === "pairing") {
    try {
      const telegramUserId = sender.userId ?? sender.candidateId;
      await createChannelPairingChallengeIssuer({
        channel: "telegram",
        upsertPairingRequest: async ({ id, meta }) =>
          await (upsertPairingRequest ?? upsertChannelPairingRequest)({
            channel: "telegram",
            id,
            accountId,
            meta,
          }),
      })({
        senderId: telegramUserId,
        senderIdLine: `Your Telegram user id: ${telegramUserId}`,
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

import type { Bot } from "grammy";
import type { Message } from "grammy/types";
import type {
  DmPolicy,
  OpenClawConfig,
  ReplyToMode,
  TelegramAccountConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { createSubsystemLogger, danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expandTelegramAllowFromWithAccessGroups } from "./access-groups.js";
import { resolveTelegramMediaRuntimeOptions, type ResolvedTelegramAccount } from "./accounts.js";
import { shouldRequestTelegramGuestUpdates } from "./allowed-updates.js";
import { isSenderAllowed, normalizeAllowFrom } from "./bot-access.js";
import type { TelegramBotDeps } from "./bot-deps.js";
import type { TelegramBotInfo } from "./bot-info.js";
import {
  buildTelegramMessageContext,
  type BuildTelegramMessageContextParams,
} from "./bot-message-context.js";
import { dispatchTelegramMessage } from "./bot-message-dispatch.js";
import { resolveDefaultAgentId } from "./bot.agent.runtime.js";
import type { TelegramBotOptions } from "./bot.types.js";
import { resolveTelegramPrimaryMedia } from "./bot/body-helpers.js";
import { resolveMedia } from "./bot/delivery.js";
import type { TelegramContext } from "./bot/types.js";
import type { TelegramTransport } from "./fetch.js";

const DEFAULT_GUEST_FALLBACK_TEXT = "I could not produce a visible answer. Please try again.";
const TELEGRAM_GUEST_MESSAGE_TEXT_LIMIT = 4096;
const GUEST_PROMPT_PREFIX =
  "Telegram Guest Mode query. Return exactly one visible final answer. " +
  "Do not use message(action=send), Telegram send tools, or source-channel delivery tools. " +
  "Telegram Guest Mode answers are delivered through answerGuestQuery; local or generated files cannot be uploaded directly in the guest answer, so explain that limitation if a file output is requested. " +
  "Do not intentionally stay silent; if you cannot complete the request, explain briefly.";
const GUEST_RESULT_TITLE = "OpenClaw";

type TelegramGuestMessage = Message & {
  guest_query_id?: string;
};

type TelegramGuestContext = TelegramContext & {
  update?: {
    guest_message?: TelegramGuestMessage;
  };
};

type TelegramAnswerGuestQueryPayload = {
  guest_query_id: string;
  result: {
    type: "article";
    id: string;
    title: string;
    input_message_content: {
      message_text: string;
    };
    description?: string;
  };
};

type TelegramGuestApi = {
  raw?: {
    answerGuestQuery?: (payload: TelegramAnswerGuestQueryPayload) => Promise<boolean>;
  };
};

type RegisterTelegramGuestHandlersParams = {
  cfg: OpenClawConfig;
  bot: Bot;
  account: ResolvedTelegramAccount;
  telegramCfg: TelegramAccountConfig;
  historyLimit: number;
  groupHistories: BuildTelegramMessageContextParams["groupHistories"];
  dmPolicy: DmPolicy;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  logger: BuildTelegramMessageContextParams["logger"];
  resolveGroupActivation: BuildTelegramMessageContextParams["resolveGroupActivation"];
  loadFreshConfig: () => OpenClawConfig;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  textLimit: number;
  opts: Pick<TelegramBotOptions, "token" | "mediaMaxMb" | "botInfo">;
  telegramTransport?: TelegramTransport;
  telegramDeps: TelegramBotDeps;
};

function isGuestModeEnabled(params: {
  telegramCfg: TelegramAccountConfig;
  botInfo?: TelegramBotInfo;
}): boolean {
  return shouldRequestTelegramGuestUpdates({
    guest: params.telegramCfg.guest,
    botInfo: params.botInfo,
  });
}

function buildGuestSessionKey(params: {
  agentId: string;
  accountId: string;
  chatId: string | number;
  senderId?: string;
}): string {
  const senderPart = params.senderId ? `:sender:${params.senderId}` : "";
  return normalizeLowercaseStringOrEmpty(
    buildAgentSessionKey({
      agentId: params.agentId,
      channel: "telegram",
      accountId: params.accountId,
      dmScope: "per-account-channel-peer",
      peer: {
        kind: "direct",
        id: `guest-from-group:${params.chatId}${senderPart}`,
      },
    }),
  );
}

function buildGuestAnswerPayload(
  guestQueryId: string,
  text: string,
): TelegramAnswerGuestQueryPayload {
  const trimmed = text.trim();
  const messageText = trimmed.slice(0, TELEGRAM_GUEST_MESSAGE_TEXT_LIMIT);
  return {
    guest_query_id: guestQueryId,
    result: {
      type: "article",
      id: `openclaw-${Date.now().toString(36)}`,
      title: GUEST_RESULT_TITLE,
      input_message_content: {
        message_text: messageText,
      },
      ...(messageText ? { description: messageText.slice(0, 120) } : {}),
    },
  };
}

async function answerGuestQuery(params: {
  bot: Bot;
  guestQueryId: string;
  text: string;
}): Promise<boolean> {
  const api = params.bot.api as unknown as TelegramGuestApi;
  const answer = api.raw?.answerGuestQuery;
  if (typeof answer !== "function") {
    throw new Error("Telegram API client does not expose raw.answerGuestQuery");
  }
  return await answer(buildGuestAnswerPayload(params.guestQueryId, params.text));
}

function resolveGuestEmbeddedReplyMessage(msg: Message): Message | undefined {
  return msg.reply_to_message;
}

type GuestMediaResolution =
  | { status: "none" }
  | { status: "resolved"; media: BuildTelegramMessageContextParams["allMedia"][number] }
  | { status: "failed"; error: unknown };

async function resolveGuestMediaRef(params: {
  bot: Bot;
  ctx: TelegramContext;
  cfg: OpenClawConfig;
  accountId: string;
  token: string;
  maxBytes: number;
  transport?: TelegramTransport;
}): Promise<GuestMediaResolution> {
  const fileRef = resolveTelegramPrimaryMedia(params.ctx.message)?.fileRef;
  if (!fileRef?.file_id) {
    return { status: "none" };
  }
  try {
    const media = await resolveMedia({
      ctx: {
        message: params.ctx.message,
        me: params.ctx.me,
        getFile: async () => await params.bot.api.getFile(fileRef.file_id),
      },
      maxBytes: params.maxBytes,
      ...resolveTelegramMediaRuntimeOptions({
        cfg: params.cfg,
        accountId: params.accountId,
        token: params.token,
        transport: params.transport,
      }),
    });
    return media
      ? {
          status: "resolved",
          media: {
            path: media.path,
            ...(media.contentType ? { contentType: media.contentType } : {}),
            ...(media.stickerMetadata ? { stickerMetadata: media.stickerMetadata } : {}),
          },
        }
      : { status: "none" };
  } catch (error) {
    return { status: "failed", error };
  }
}

async function resolveGuestMessageMedia(params: {
  bot: Bot;
  cfg: OpenClawConfig;
  accountId: string;
  primaryCtx: TelegramContext;
  token: string;
  maxBytes: number;
  transport?: TelegramTransport;
  logger: BuildTelegramMessageContextParams["logger"];
}): Promise<{
  allMedia: BuildTelegramMessageContextParams["allMedia"];
  replyMedia: BuildTelegramMessageContextParams["allMedia"];
  currentMediaFailed: boolean;
}> {
  const resolveOne = async (ctx: TelegramContext, label: "current" | "reply") => {
    const result = await resolveGuestMediaRef({
      bot: params.bot,
      ctx,
      cfg: params.cfg,
      accountId: params.accountId,
      token: params.token,
      maxBytes: params.maxBytes,
      transport: params.transport,
    });
    if (result.status === "failed") {
      params.logger.info(
        { error: String(result.error), label },
        "telegram guest media fetch failed",
      );
    }
    return result;
  };
  const current = await resolveOne(params.primaryCtx, "current");
  const replyMessage = resolveGuestEmbeddedReplyMessage(params.primaryCtx.message);
  const reply = replyMessage
    ? await resolveOne(
        {
          message: replyMessage,
          me: params.primaryCtx.me,
          getFile: async () => ({}),
        },
        "reply",
      )
    : undefined;
  return {
    allMedia: current?.status === "resolved" ? [current.media] : [],
    replyMedia: reply?.status === "resolved" ? [reply.media] : [],
    currentMediaFailed: current?.status === "failed",
  };
}

export function registerTelegramGuestHandlers(params: RegisterTelegramGuestHandlersParams): void {
  const guestLog = createSubsystemLogger("gateway/channels/telegram/guest");
  const sessionRuntime = {
    ...(params.telegramDeps.buildChannelInboundEventContext
      ? { buildChannelInboundEventContext: params.telegramDeps.buildChannelInboundEventContext }
      : {}),
    ...(params.telegramDeps.readSessionUpdatedAt
      ? { readSessionUpdatedAt: params.telegramDeps.readSessionUpdatedAt }
      : {}),
    ...(params.telegramDeps.recordInboundSession
      ? { recordInboundSession: params.telegramDeps.recordInboundSession }
      : {}),
    ...(params.telegramDeps.resolveInboundLastRouteSessionKey
      ? { resolveInboundLastRouteSessionKey: params.telegramDeps.resolveInboundLastRouteSessionKey }
      : {}),
    ...(params.telegramDeps.resolvePinnedMainDmOwnerFromAllowlist
      ? {
          resolvePinnedMainDmOwnerFromAllowlist:
            params.telegramDeps.resolvePinnedMainDmOwnerFromAllowlist,
        }
      : {}),
    resolveStorePath: params.telegramDeps.resolveStorePath,
  };
  const contextRuntime = params.telegramDeps.recordChannelActivity
    ? { recordChannelActivity: params.telegramDeps.recordChannelActivity }
    : undefined;

  params.bot.use(async (ctx, next) => {
    const guestCtx = ctx as unknown as TelegramGuestContext;
    const msg = guestCtx.update?.guest_message;
    if (!msg) {
      await next();
      return;
    }
    if (!isGuestModeEnabled({ telegramCfg: params.telegramCfg, botInfo: params.opts.botInfo })) {
      logVerbose("telegram guest: skipped guest_message because guest mode is disabled");
      return;
    }
    const guestQueryId = msg.guest_query_id?.trim();
    if (!guestQueryId) {
      guestLog.debug("telegram guest: skipped guest_message without guest_query_id");
      return;
    }

    const fallbackText = params.telegramCfg.guest?.fallbackText ?? DEFAULT_GUEST_FALLBACK_TEXT;
    let answered = false;
    const answerText = async (text: string) => {
      if (answered) {
        return true;
      }
      answered = await answerGuestQuery({
        bot: params.bot,
        guestQueryId,
        text,
      });
      return answered;
    };

    try {
      const chatId = msg.chat.id;
      const senderId = msg.from?.id != null ? String(msg.from.id) : "";
      const senderUsername = msg.from?.username ?? "";
      const freshCfg = params.loadFreshConfig();
      const effectiveGuestAllow = normalizeAllowFrom(
        await expandTelegramAllowFromWithAccessGroups({
          cfg: freshCfg,
          allowFrom: params.allowFrom,
          accountId: params.account.accountId,
          senderId,
        }),
      );
      if (
        !effectiveGuestAllow.hasEntries ||
        !isSenderAllowed({
          allow: effectiveGuestAllow,
          senderId,
          senderUsername,
        })
      ) {
        logVerbose(
          `telegram guest: blocked guest_message from ${senderId || "unknown"} (allowFrom)`,
        );
        return;
      }
      const routeAgentId = resolveDefaultAgentId(params.cfg);
      const guestConversationId = `guest-from-group:${chatId}:sender:${senderId || "unknown"}`;
      const primaryCtx: TelegramContext = {
        message: msg,
        me: guestCtx.me,
        getFile:
          typeof guestCtx.getFile === "function"
            ? guestCtx.getFile.bind(guestCtx)
            : async () => ({}),
      };
      const mediaMaxBytes =
        (params.opts.mediaMaxMb ?? params.telegramCfg.mediaMaxMb ?? 100) * 1024 * 1024;
      const { allMedia, replyMedia, currentMediaFailed } = await resolveGuestMessageMedia({
        bot: params.bot,
        cfg: freshCfg,
        accountId: params.account.accountId,
        primaryCtx,
        token: params.opts.token,
        maxBytes: mediaMaxBytes,
        transport: params.telegramTransport,
        logger: params.logger,
      });
      if (currentMediaFailed) {
        await answerText(fallbackText);
        return;
      }
      const context = await buildTelegramMessageContext({
        primaryCtx,
        allMedia: [...allMedia, ...replyMedia],
        replyMedia,
        storeAllowFrom: [],
        options: {
          forceWasMentioned: true,
          sessionKeyOverride: buildGuestSessionKey({
            agentId: routeAgentId,
            accountId: params.account.accountId,
            chatId,
            senderId,
          }),
          routeAgentIdOverride: routeAgentId,
          messageIdOverride: `guest:${guestQueryId}`,
          systemPromptPrefix: GUEST_PROMPT_PREFIX,
          skipGroupBaseAccess: true,
          conversationKindOverride: "direct",
          fromOverride: `telegram:${guestConversationId}`,
          conversationIdOverride: guestConversationId,
          conversationLabelOverride: "Telegram Guest Mode",
          originatingToOverride: `telegram:guest:${guestQueryId}`,
          suppressUpdateLastRoute: true,
        },
        bot: params.bot,
        cfg: params.cfg,
        account: params.account,
        historyLimit: params.historyLimit,
        groupHistories: params.groupHistories,
        dmPolicy: params.dmPolicy,
        allowFrom: params.allowFrom,
        groupAllowFrom: params.groupAllowFrom,
        ackReactionScope: "off",
        logger: params.logger,
        resolveGroupActivation: params.resolveGroupActivation,
        resolveGroupRequireMention: () => false,
        resolveTelegramGroupConfig: () => ({}),
        sendChatActionHandler: {
          sendChatAction: async () => undefined,
          isSuspended: () => false,
          reset: () => undefined,
        },
        loadFreshConfig: params.loadFreshConfig,
        runtime: contextRuntime,
        sessionRuntime,
        upsertPairingRequest: params.telegramDeps.upsertChannelPairingRequest,
      });
      if (!context) {
        await answerText(fallbackText);
        return;
      }
      await dispatchTelegramMessage({
        context: {
          ...context,
          sendTyping: async () => undefined,
          sendRecordVoice: async () => undefined,
          ackReactionPromise: null,
          reactionApi: null,
          removeAckAfterReply: false,
          statusReactionController: null,
        },
        bot: params.bot,
        cfg: params.cfg,
        runtime: params.runtime,
        replyToMode: params.replyToMode,
        streamMode: "off",
        textLimit: params.textLimit,
        telegramCfg: params.telegramCfg,
        telegramDeps: params.telegramDeps,
        opts: params.opts,
        sourceReplyDeliveryMode: "automatic",
        guestDelivery: { answerText },
      });
      if (!answered) {
        await answerText(fallbackText);
      }
    } catch (err) {
      params.runtime.error?.(danger(`telegram guest message processing failed: ${String(err)}`));
      if (!answered) {
        try {
          await answerText(fallbackText);
        } catch {}
      }
    }
  });
}

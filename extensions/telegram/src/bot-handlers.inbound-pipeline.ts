import type { Context } from "grammy";
import type { Message } from "grammy/types";
import type { TelegramGroupConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ChannelReplayClaimHandle } from "openclaw/plugin-sdk/persistent-dedupe";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { asFiniteNumber } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import type { TelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import { createTelegramInboundProcessing } from "./bot-handlers.inbound-processing.js";
import type { TelegramInboundProcessing } from "./bot-handlers.inbound-processing.js";
import {
  buildSyntheticContext,
  promptContextBoundaryOptions,
} from "./bot-handlers.message-context.js";
import type { TelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type {
  RegisterTelegramHandlerParams,
  TelegramInboundDisposition,
  TelegramInboundPipeline,
} from "./bot-handlers.types.js";
import {
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import type { TelegramUpdateKeyContext } from "./bot-updates.js";
import {
  resolveTelegramBotHasTopicsEnabled,
  resolveTelegramForumFlag,
  withResolvedTelegramForumFlag,
  TelegramPairingStoreReadError,
} from "./bot/helpers.js";
import type { TelegramContext, TelegramGetChat } from "./bot/types.js";
import { emitTelegramLiveLocationMessageHook } from "./location-message-hook.js";

type TelegramMessageHandlerParams = Pick<
  RegisterTelegramHandlerParams,
  "accountId" | "bot" | "shouldSkipUpdate"
> & {
  opts: Pick<RegisterTelegramHandlerParams["opts"], "botInfo">;
  runtime: Pick<RegisterTelegramHandlerParams["runtime"], "error">;
};

type TelegramMessageHandlerRuntime = Pick<
  TelegramMessagePipeline,
  | "releaseDispatchDedupeClaims"
  | "claimMessageDispatchDedupe"
  | "resolveTelegramSessionState"
  | "resolvePromptContextAmbientWatermark"
> & {
  recordMessageForReplyChain: (
    ...args: Parameters<TelegramMessagePipeline["recordMessageForReplyChain"]>
  ) => Promise<unknown>;
};

interface TelegramInboundHandlers {
  handleMessage: (ctx: Context) => Promise<TelegramInboundDisposition>;
  handleEditedMessage: (
    ctx: Context,
    kind: "edited_message" | "edited_channel_post",
  ) => Promise<TelegramInboundDisposition>;
  handleChannelPost: (ctx: Context) => Promise<TelegramInboundDisposition>;
}

function createTelegramInboundHandlers(
  { accountId, bot, opts, runtime, shouldSkipUpdate }: TelegramMessageHandlerParams,
  messageRuntime: TelegramMessageHandlerRuntime,
  authorizationRuntime: Pick<TelegramHandlerAuthorization, "authorizeInboundMessage">,
  inboundRuntime: Pick<TelegramInboundProcessing, "processInboundMessage">,
): TelegramInboundHandlers {
  const {
    releaseDispatchDedupeClaims,
    claimMessageDispatchDedupe,
    resolveTelegramSessionState,
    resolvePromptContextAmbientWatermark,
    recordMessageForReplyChain,
  } = messageRuntime;
  const { authorizeInboundMessage } = authorizationRuntime;
  const { processInboundMessage } = inboundRuntime;
  const getChat: TelegramGetChat = bot.api.getChat.bind(bot.api);
  const resolveBotUserId = (ctx: { me?: { id?: number } }): number => {
    const botUserId = ctx.me?.id ?? opts.botInfo?.id;
    if (botUserId == null) {
      throw new Error("Telegram bot identity is unavailable");
    }
    return botUserId;
  };
  type InboundTelegramEvent = {
    ctxForDedupe: TelegramUpdateKeyContext;
    ctx: TelegramContext;
    botUserId: number;
    msg: Message;
    chatId: number;
    isGroup: boolean;
    isForum: boolean;
    senderId: string;
    senderUsername: string;
    requireConfiguredGroup: boolean;
    sendOversizeWarning: boolean;
    oversizeLogMessage: string;
    errorMessage: string;
  };

  const normalizeChannelPostMessage = (post: Message): Message => {
    const senderChat = post.sender_chat ?? post.chat;
    const syntheticFrom = {
      id: senderChat.id,
      is_bot: true as const,
      first_name: senderChat.title || "Channel",
      ...(senderChat.username !== undefined ? { username: senderChat.username } : {}),
    };
    return {
      ...post,
      from: post.from ?? syntheticFrom,
      chat: {
        ...post.chat,
        type: "supergroup" as const,
      },
    } as Message;
  };
  const recordEditedMessageForReplyChain = async (params: {
    ctxForDedupe: TelegramUpdateKeyContext;
    msg: Message;
    requireConfiguredGroup: boolean;
    botUserId: number;
    providerUpdate?: { id: number; kind: "edited_message" | "edited_channel_post" };
  }) => {
    if (shouldSkipUpdate(params.ctxForDedupe)) {
      return;
    }
    const msg = params.msg;
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    const isForum = await resolveTelegramForumFlag({
      chatId: msg.chat.id,
      chatType: msg.chat.type,
      isGroup,
      isForum: msg.chat.is_forum,
      isTopicMessage: msg.is_topic_message,
      getChat,
    });
    const normalizedMsg = withResolvedTelegramForumFlag(msg, isForum);
    const gate = await authorizeInboundMessage({
      msg: normalizedMsg,
      chatId: normalizedMsg.chat.id,
      isGroup,
      isForum,
      senderId: normalizedMsg.from?.id != null ? String(normalizedMsg.from.id) : "",
      senderUsername: normalizedMsg.from?.username ?? "",
      requireConfiguredGroup: params.requireConfiguredGroup,
      dmAccess: "silent",
    });
    if (!gate.allowed) {
      return;
    }
    await recordMessageForReplyChain(normalizedMsg, gate.context.threadSpec, params.botUserId);
    if (params.providerUpdate) {
      emitTelegramLiveLocationMessageHook({
        accountId,
        msg: normalizedMsg,
        updateId: params.providerUpdate.id,
        updateKind: params.providerUpdate.kind,
        isForum,
      });
    }
  };

  const handleInboundMessageLike = async (
    event: InboundTelegramEvent,
  ): Promise<TelegramInboundDisposition> => {
    let dispatchDedupeClaims: ChannelReplayClaimHandle[] = [];
    try {
      if (shouldSkipUpdate(event.ctxForDedupe)) {
        return { kind: "ignored" };
      }
      const gate = await authorizeInboundMessage({
        msg: event.msg,
        chatId: event.chatId,
        isGroup: event.isGroup,
        isForum: event.isForum,
        senderId: event.senderId,
        senderUsername: event.senderUsername,
        requireConfiguredGroup: event.requireConfiguredGroup,
        dmAccess: "challenge",
      });
      if (!gate.allowed) {
        return { kind: "ignored" };
      }
      const { effectiveDmAllow } = gate;
      const {
        dmPolicy,
        resolvedThreadId,
        storeAllowFrom,
        groupConfig,
        topicConfig,
        effectiveGroupAllow,
        threadSpec,
      } = gate.context;

      const sessionState = await resolveTelegramSessionState({
        chatId: event.chatId,
        isGroup: event.isGroup,
        threadSpec,
        botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(event.ctx.me),
        senderId: event.senderId,
        runtimeCfg: gate.context.cfg,
      });
      const promptContextMinTimestampMs = asFiniteNumber(
        sessionState.sessionEntry?.sessionStartedAt,
      );
      const promptContextAmbientWatermark = resolvePromptContextAmbientWatermark({
        chatId: event.chatId,
        isGroup: event.isGroup,
        resolvedThreadId,
        sessionKey: sessionState.sessionKey,
        storePath: sessionState.storePath,
      });

      const dispatchDedupe = await claimMessageDispatchDedupe(event.msg, event.botUserId);
      if (!dispatchDedupe.process) {
        return { kind: "ignored" };
      }
      dispatchDedupeClaims = dispatchDedupe.claims;
      await recordMessageForReplyChain(event.msg, gate.context.threadSpec, event.botUserId);
      return await processInboundMessage({
        authorizationCfg: gate.context.cfg,
        ctx: event.ctx,
        msg: event.msg,
        chatId: event.chatId,
        isGroup: event.isGroup,
        isForum: event.isForum,
        threadSpec,
        dmPolicy,
        storeAllowFrom,
        senderId: event.senderId,
        effectiveGroupAllow,
        effectiveDmAllow,
        channelIngressResolver: gate.resolveChannelIngress,
        groupConfig: event.isGroup ? (groupConfig as TelegramGroupConfig | undefined) : undefined,
        topicConfig,
        sendOversizeWarning: event.sendOversizeWarning,
        oversizeLogMessage: event.oversizeLogMessage,
        dispatchDedupeClaims,
        ...promptContextBoundaryOptions(promptContextMinTimestampMs, promptContextAmbientWatermark),
      });
    } catch (err) {
      releaseDispatchDedupeClaims(dispatchDedupeClaims, err);
      runtime.error?.(danger(`${event.errorMessage}: ${String(err)}`));
      const spooledReplay = isTelegramSpooledReplayUpdate(event.ctx.update);
      if (err instanceof TelegramPairingStoreReadError || spooledReplay) {
        recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: err });
        // Spooled replays are durably retried; live updates get one apology
        // because they are acked without replay.
        if (spooledReplay) {
          return { kind: "ignored" };
        }
        await withTelegramApiErrorLogging({
          operation: "sendMessage",
          runtime,
          fn: () =>
            bot.api.sendMessage(
              event.chatId,
              "⚠️ Couldn't process this message, please try again in a moment.",
              {
                reply_parameters: {
                  message_id: event.msg.message_id,
                  allow_sending_without_reply: true,
                },
              },
            ),
        }).catch(() => {});
      }
      return { kind: "ignored" };
    }
  };

  const handleMessage = async (ctx: Context): Promise<TelegramInboundDisposition> => {
    const msg = ctx.message;
    if (!msg) {
      return { kind: "ignored" };
    }
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    const isForum = await resolveTelegramForumFlag({
      chatId: msg.chat.id,
      chatType: msg.chat.type,
      isGroup,
      isForum: msg.chat.is_forum,
      isTopicMessage: msg.is_topic_message,
      getChat,
    });
    const normalizedMsg = withResolvedTelegramForumFlag(msg, isForum);
    const botUserId = resolveBotUserId(ctx);
    // Bot-authored message updates can be echoed back by Telegram. Skip them here
    // and rely on the dedicated channel_post handler for channel-originated posts.
    if (normalizedMsg.from?.id != null && normalizedMsg.from.id === botUserId) {
      return { kind: "ignored" };
    }
    return await handleInboundMessageLike({
      ctxForDedupe: ctx,
      ctx: buildSyntheticContext(ctx, normalizedMsg),
      botUserId,
      msg: normalizedMsg,
      chatId: normalizedMsg.chat.id,
      isGroup,
      isForum,
      senderId: normalizedMsg.from?.id != null ? String(normalizedMsg.from.id) : "",
      senderUsername: normalizedMsg.from?.username ?? "",
      requireConfiguredGroup: false,
      sendOversizeWarning: true,
      oversizeLogMessage: "media exceeds size limit",
      errorMessage: "handler failed",
    });
  };

  const handleEditedMessage: TelegramInboundHandlers["handleEditedMessage"] = async (ctx, kind) => {
    const isChannelPost = kind === "edited_channel_post";
    const msg = isChannelPost ? ctx.editedChannelPost : ctx.editedMessage;
    if (!msg) {
      return { kind: "ignored" };
    }
    await recordEditedMessageForReplyChain({
      ctxForDedupe: ctx,
      msg: isChannelPost ? normalizeChannelPostMessage(msg) : msg,
      requireConfiguredGroup: isChannelPost,
      botUserId: resolveBotUserId(ctx),
      providerUpdate:
        typeof ctx.update?.update_id === "number" ? { id: ctx.update.update_id, kind } : undefined,
    });
    return { kind: "recorded" };
  };

  const handleChannelPost = async (ctx: Context): Promise<TelegramInboundDisposition> => {
    const post = ctx.channelPost;
    if (!post) {
      return { kind: "ignored" };
    }

    const chatId = post.chat.id;
    const syntheticMsg = normalizeChannelPostMessage(post);

    return await handleInboundMessageLike({
      ctxForDedupe: ctx,
      ctx: buildSyntheticContext(ctx, syntheticMsg),
      botUserId: resolveBotUserId(ctx),
      msg: syntheticMsg,
      chatId,
      isGroup: true,
      isForum: false,
      senderId:
        post.sender_chat?.id != null
          ? String(post.sender_chat.id)
          : post.from?.id != null
            ? String(post.from.id)
            : "",
      senderUsername: post.sender_chat?.username ?? post.from?.username ?? "",
      requireConfiguredGroup: true,
      sendOversizeWarning: false,
      oversizeLogMessage: "channel post media exceeds size limit",
      errorMessage: "channel_post handler failed",
    });
  };

  return { handleMessage, handleEditedMessage, handleChannelPost };
}

export function createTelegramInboundPipeline({
  params,
  message,
  authorization,
}: {
  params: RegisterTelegramHandlerParams;
  message: TelegramMessagePipeline;
  authorization: TelegramHandlerAuthorization;
}): TelegramInboundPipeline {
  const processing = createTelegramInboundProcessing({ params, message });
  const handlers = createTelegramInboundHandlers(params, message, authorization, processing);
  return {
    handle: async (ctx) => {
      if (ctx.message) {
        return await handlers.handleMessage(ctx);
      }
      if (ctx.editedMessage) {
        return await handlers.handleEditedMessage(ctx, "edited_message");
      }
      if (ctx.channelPost) {
        return await handlers.handleChannelPost(ctx);
      }
      if (ctx.editedChannelPost) {
        return await handlers.handleEditedMessage(ctx, "edited_channel_post");
      }
      return { kind: "ignored" };
    },
  };
}

export function registerTelegramInboundHandlers({
  bot,
  pipeline,
}: {
  bot: RegisterTelegramHandlerParams["bot"];
  pipeline: Pick<TelegramInboundPipeline, "handle">;
}): void {
  bot.on("message", pipeline.handle);
  bot.on("edited_message", pipeline.handle);
  bot.on("channel_post", pipeline.handle);
  bot.on("edited_channel_post", pipeline.handle);
}

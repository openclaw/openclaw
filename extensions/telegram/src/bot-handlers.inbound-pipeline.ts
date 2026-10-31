import type { Context } from "grammy";
import type { Message } from "grammy/types";
import {
  isAbortRequestText,
  isBtwRequestText,
} from "openclaw/plugin-sdk/command-primitives-runtime";
import type { TelegramGroupConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatByteSize } from "openclaw/plugin-sdk/number-runtime";
import type { ChannelReplayClaimHandle } from "openclaw/plugin-sdk/persistent-dedupe";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { asFiniteNumber } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { buildTelegramInboundDebounceKey } from "./bot-handlers.debounce-key.js";
import type { TelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import {
  createTelegramInboundBuffers,
  type TelegramDebounceEntry,
  type TelegramInboundMediaHydration,
} from "./bot-handlers.inbound-buffer.js";
import { createTelegramInboundMedia } from "./bot-handlers.inbound-media.js";
import {
  isDurablyRetryableInboundMediaError,
  isMediaSizeLimitError,
  TelegramBotApiFileTooLargeError,
} from "./bot-handlers.media.js";
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
import type { TelegramMediaRef } from "./bot-message-context.types.js";
import {
  createTelegramSpooledReplayDeferredParticipant,
  getTelegramSpooledReplayLifecycle,
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import { resolveMedia } from "./bot/delivery.resolve-media.js";
import {
  buildTelegramGroupPeerId,
  getTelegramTextParts,
  resolveTelegramBotHasTopicsEnabled,
  resolveTelegramForumFlag,
  resolveTelegramPrimaryMedia,
  withResolvedTelegramForumFlag,
  TelegramPairingStoreReadError,
} from "./bot/helpers.js";
import type { TelegramGetChat } from "./bot/types.js";
import { resolveTelegramCommandIngressAuthorization } from "./ingress.js";
import { emitTelegramLiveLocationMessageHook } from "./location-message-hook.js";
import { isTelegramControlLaneText } from "./sequential-key.js";

export function createTelegramInboundPipeline({
  params: handlerParams,
  message: messageRuntime,
  authorization: authorizationRuntime,
}: {
  params: RegisterTelegramHandlerParams;
  message: TelegramMessagePipeline;
  authorization: TelegramHandlerAuthorization;
}): TelegramInboundPipeline {
  const { accountId, bot, opts, runtime, shouldSkipUpdate, mediaMaxBytes, logger } = handlerParams;
  const {
    resolveMediaRuntime,
    recordMessageResolvedMedia,
    releaseDispatchDedupeClaims,
    claimMessageDispatchDedupe,
    resolveTelegramSessionState,
    resolvePromptContextAmbientWatermark,
    recordMessageForReplyChain,
  } = messageRuntime;
  const { authorizeInboundMessage } = authorizationRuntime;
  const { cancelPending, inboundDebouncer, resolveTelegramDebounceLane } =
    createTelegramInboundBuffers({ params: handlerParams, message: messageRuntime });

  const {
    handleMediaGroup,
    pendingMediaGroups,
    resolveUnaddressedGroupMediaDisposition,
    sendMediaWarning,
  } = createTelegramInboundMedia({
    params: handlerParams,
    message: messageRuntime,
  });
  const getChat: TelegramGetChat = bot.api.getChat.bind(bot.api);
  const resolveForumFlag = (msg: Message, isGroup: boolean) =>
    resolveTelegramForumFlag({
      chatId: msg.chat.id,
      chatType: msg.chat.type,
      isGroup,
      isForum: msg.chat.is_forum,
      isTopicMessage: msg.is_topic_message,
      getChat,
    });
  const resolveBotUserId = (ctx: { me?: { id?: number } }): number => {
    const botUserId = ctx.me?.id ?? opts.botInfo?.id;
    if (botUserId == null) {
      throw new Error("Telegram bot identity is unavailable");
    }
    return botUserId;
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
  const handleMessage = async (
    ctx: Context,
    kind: "message" | "channel_post",
  ): Promise<TelegramInboundDisposition> => {
    const isChannelPost = kind === "channel_post";
    const msg = isChannelPost ? ctx.channelPost : ctx.message;
    if (!msg) {
      return { kind: "ignored" };
    }
    const isGroup = isChannelPost || msg.chat.type === "group" || msg.chat.type === "supergroup";
    const isForum = isChannelPost ? false : await resolveForumFlag(msg, isGroup);
    const normalizedMsg = isChannelPost
      ? normalizeChannelPostMessage(msg)
      : withResolvedTelegramForumFlag(msg, isForum);
    const botUserId = resolveBotUserId(ctx);
    // Bot-authored message updates can be echoed back by Telegram. Channel-originated posts
    // remain eligible even when their sender is this bot.
    if (!isChannelPost && normalizedMsg.from?.id != null && normalizedMsg.from.id === botUserId) {
      return { kind: "ignored" };
    }
    const chatId = normalizedMsg.chat.id;
    const syntheticContext = buildSyntheticContext(ctx, normalizedMsg);
    const senderId =
      isChannelPost && msg.sender_chat?.id != null
        ? String(msg.sender_chat.id)
        : msg.from?.id != null
          ? String(msg.from.id)
          : "";
    let dispatchDedupeClaims: ChannelReplayClaimHandle[] = [];
    try {
      if (shouldSkipUpdate(ctx)) {
        return { kind: "ignored" };
      }
      const gate = await authorizeInboundMessage({
        msg: normalizedMsg,
        chatId,
        isGroup,
        isForum,
        senderId,
        requireConfiguredGroup: isChannelPost,
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
        chatId,
        isGroup,
        threadSpec,
        botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(syntheticContext.me),
        senderId,
        runtimeCfg: gate.context.cfg,
      });
      const promptContextMinTimestampMs = asFiniteNumber(
        sessionState.sessionEntry?.sessionStartedAt,
      );
      const promptContextAmbientWatermark = await resolvePromptContextAmbientWatermark({
        chatId,
        isGroup,
        resolvedThreadId,
        sessionKey: sessionState.sessionKey,
        storePath: sessionState.storePath,
      });

      const dispatchDedupe = await claimMessageDispatchDedupe(normalizedMsg, botUserId);
      if (!dispatchDedupe.process) {
        return { kind: "ignored" };
      }
      dispatchDedupeClaims = dispatchDedupe.claims;
      await recordMessageForReplyChain(normalizedMsg, gate.context.threadSpec, botUserId);
      const mediaInput = {
        authorizationCfg: gate.context.cfg,
        ctx: syntheticContext,
        msg: normalizedMsg,
        chatId,
        isGroup,
        threadSpec,
        storeAllowFrom,
        senderId,
        effectiveGroupAllow,
        effectiveDmAllow,
        groupConfig: isGroup ? (groupConfig as TelegramGroupConfig | undefined) : undefined,
        topicConfig,
        dispatchDedupeClaims,
        ...promptContextBoundaryOptions(promptContextMinTimestampMs, promptContextAmbientWatermark),
      };
      const processingThreadId =
        threadSpec.scope === "forum" || threadSpec.scope === "direct-messages"
          ? threadSpec.id
          : undefined;

      const messageText = getTelegramTextParts(normalizedMsg).text;
      const botUsername = syntheticContext.me?.username;
      const isAbortControlMessage = isAbortRequestText(messageText, { botUsername });
      const bypassTextBuffer =
        isTelegramControlLaneText({ rawText: messageText, botUsername }) ||
        isBtwRequestText(messageText, { botUsername });
      const abortControlAuthorized =
        isAbortControlMessage && senderId
          ? resolveTelegramCommandIngressAuthorization({
              accountId,
              cfg: gate.context.cfg,
              dmPolicy,
              isGroup,
              chatId,
              resolvedThreadId: processingThreadId,
              senderId,
              effectiveDmAllow,
              effectiveGroupAllow,
              eventKind: "message",
              allowTextCommands: true,
              hasControlCommand: true,
              modeWhenAccessGroupsOff: "allow",
              includeDmAllowForGroupCommands: false,
            }).then((authorization) => authorization.authorized)
          : Promise.resolve(false);

      if (await abortControlAuthorized) {
        cancelPending({ chatId, threadSpec, senderId });
      }

      if (
        handleMediaGroup({
          ...mediaInput,
          channelIngressResolvers: [gate.resolveChannelIngress],
        })
      ) {
        return { kind: "buffered", buffer: "media-group" };
      }

      // Wait in the ordinary conversation lane, never the independent control lane.
      // The album queue releases at adoption (or claim release), not reply completion.
      const pendingAlbums = !bypassTextBuffer && pendingMediaGroups(mediaInput);
      if (pendingAlbums) {
        const lifecycle = getTelegramSpooledReplayLifecycle();
        const intervalMs = lifecycle?.deferredHeartbeatIntervalMs;
        const heartbeat =
          intervalMs === undefined
            ? undefined
            : setInterval(() => lifecycle?.onDeferredHeartbeat?.(), intervalMs);
        heartbeat?.unref();
        try {
          await pendingAlbums;
        } finally {
          clearInterval(heartbeat);
        }
      }

      const mediaDisposition = await resolveUnaddressedGroupMediaDisposition(mediaInput);
      if (mediaDisposition === "skip") {
        releaseDispatchDedupeClaims(dispatchDedupeClaims);
        return { kind: "ignored" };
      }

      const nativeMedia = resolveTelegramPrimaryMedia(normalizedMsg);
      const replayingSpooledUpdate = isTelegramSpooledReplayUpdate(syntheticContext.update);
      const hydrateMedia = async (
        abortSignals: readonly AbortSignal[],
      ): Promise<TelegramInboundMediaHydration> => {
        const mediaRuntime = resolveMediaRuntime(...abortSignals);
        let media: Awaited<ReturnType<typeof resolveMedia>> = null;
        let unavailable: TelegramMediaRef["unavailable"];
        try {
          media = await resolveMedia({
            ctx: syntheticContext,
            maxBytes: mediaMaxBytes,
            ...mediaRuntime,
          });
          if (mediaRuntime.abortSignal?.aborted) {
            return {
              kind: "retry",
              error:
                mediaRuntime.abortSignal.reason ??
                new Error("telegram media hydration owner aborted"),
            };
          }
          if (media) {
            await recordMessageResolvedMedia({
              msg: normalizedMsg,
              media,
              botUserId: syntheticContext.me?.id,
            });
          }
        } catch (mediaErr) {
          if (mediaRuntime.abortSignal?.aborted && isDurablyRetryableInboundMediaError(mediaErr)) {
            // Abort mid-media-resolution must stay retryable for live updates too;
            // a clean claim release would settle the update as handled and silently
            // drop the message during shutdown or deadline cancellation.
            return { kind: "retry", error: mediaErr };
          }
          if (isMediaSizeLimitError(mediaErr)) {
            const limitBytes =
              mediaErr instanceof TelegramBotApiFileTooLargeError
                ? Math.min(mediaErr.limitMb * 1024 * 1024, mediaMaxBytes)
                : mediaMaxBytes;
            const limit = formatByteSize(limitBytes, {
              style: "legacy-binary",
              maxUnit: "mega",
              separator: "",
              fractionDigits: (value) => (Number.isInteger(value) ? 0 : 2),
            });
            unavailable = { reason: "oversize", limit };
            if (!isChannelPost && mediaDisposition !== "silent-ingest") {
              await sendMediaWarning(mediaInput, `⚠️ File too large. Maximum size is ${limit}.`);
            }
            logger.warn(
              { chatId, error: String(mediaErr) },
              isChannelPost ? "channel post media exceeds size limit" : "media exceeds size limit",
            );
          } else {
            logger.warn({ chatId, error: String(mediaErr) }, "media fetch failed");
            if (replayingSpooledUpdate && isDurablyRetryableInboundMediaError(mediaErr)) {
              return { kind: "retry", error: mediaErr };
            }
            unavailable = { reason: "download-failed" };
            if (mediaDisposition !== "silent-ingest") {
              await sendMediaWarning(mediaInput, "⚠️ Failed to download media. Please try again.");
            }
          }
        }
        const allMedia: TelegramMediaRef[] = nativeMedia
          ? [
              media
                ? {
                    path: media.path,
                    contentType: media.contentType,
                    ...(media.fileName ? { fileName: media.fileName } : {}),
                    kind: media.kind,
                    fileUniqueId: media.fileUniqueId,
                    stickerMetadata: media.stickerMetadata,
                  }
                : { kind: nativeMedia.kind, unavailable },
            ]
          : [];
        return { kind: "ready", allMedia };
      };
      const conversationKey = buildTelegramGroupPeerId(chatId, threadSpec);
      const debounceLane = resolveTelegramDebounceLane(normalizedMsg);
      const debounceSenderId =
        senderId || (normalizedMsg.from?.id != null ? String(normalizedMsg.from.id) : "");
      const debounceKey = debounceSenderId
        ? buildTelegramInboundDebounceKey({
            accountId,
            conversationKey,
            senderId: debounceSenderId,
          })
        : null;
      const createDebounceEntry = (allMedia: TelegramMediaRef[]): TelegramDebounceEntry => ({
        ctx: syntheticContext,
        msg: normalizedMsg,
        allMedia,
        storeAllowFrom,
        receivedAtMs: Date.now(),
        // Waiting here would hold the shared control lane and block /stop in other topics.
        debounceKey: bypassTextBuffer ? null : debounceKey,
        debounceLane,
        botUsername,
        threadSpec,
        ...promptContextBoundaryOptions(promptContextMinTimestampMs, promptContextAmbientWatermark),
        dispatchDedupeClaims,
        channelIngressResolvers: [gate.resolveChannelIngress],
      });
      let debounceEntry = createDebounceEntry([]);
      if (
        nativeMedia &&
        debounceLane === "forward" &&
        inboundDebouncer.shouldBuffer(debounceEntry)
      ) {
        // Downloading here would spend the forward quiet window and split the burst.
        debounceEntry.hydrateMedia = hydrateMedia;
      } else {
        const hydration = await hydrateMedia([]);
        if (hydration.kind === "retry") {
          recordTelegramMessageProcessingResult({
            kind: "failed-retryable",
            error: hydration.error,
          });
          releaseDispatchDedupeClaims(dispatchDedupeClaims, hydration.error);
          return { kind: "ignored" };
        }
        debounceEntry = createDebounceEntry(hydration.allMedia);
      }
      const shouldBufferDebounce = inboundDebouncer.shouldBuffer(debounceEntry);
      if (shouldBufferDebounce) {
        debounceEntry.spooledReplayParticipant =
          createTelegramSpooledReplayDeferredParticipant(
            `inbound-debounce:${debounceEntry.debounceKey}`,
          ) ?? undefined;
      }
      await inboundDebouncer.enqueue(debounceEntry);
      return shouldBufferDebounce
        ? { kind: "buffered", buffer: "debounce" }
        : { kind: "processed" };
    } catch (err) {
      releaseDispatchDedupeClaims(dispatchDedupeClaims, err);
      const errorMessage = isChannelPost ? "channel_post handler failed" : "handler failed";
      runtime.error?.(danger(`${errorMessage}: ${String(err)}`));
      const spooledReplay = isTelegramSpooledReplayUpdate(syntheticContext.update);
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
              chatId,
              "⚠️ Couldn't process this message, please try again in a moment.",
              {
                reply_parameters: {
                  message_id: normalizedMsg.message_id,
                  allow_sending_without_reply: true,
                },
              },
            ),
        }).catch(() => {});
      }
      return { kind: "ignored" };
    }
  };

  const handleEditedMessage = async (
    ctx: Context,
    kind: "edited_message" | "edited_channel_post",
  ): Promise<TelegramInboundDisposition> => {
    const isChannelPost = kind === "edited_channel_post";
    const original = isChannelPost ? ctx.editedChannelPost : ctx.editedMessage;
    if (!original) {
      return { kind: "ignored" };
    }
    const msg = isChannelPost ? normalizeChannelPostMessage(original) : original;
    const botUserId = resolveBotUserId(ctx);
    const updateId = ctx.update?.update_id;
    if (shouldSkipUpdate(ctx)) {
      return { kind: "recorded" };
    }
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    const isForum = await resolveForumFlag(msg, isGroup);
    const normalizedMsg = withResolvedTelegramForumFlag(msg, isForum);
    const gate = await authorizeInboundMessage({
      msg: normalizedMsg,
      chatId: normalizedMsg.chat.id,
      isGroup,
      isForum,
      senderId: normalizedMsg.from?.id != null ? String(normalizedMsg.from.id) : "",
      requireConfiguredGroup: isChannelPost,
      dmAccess: "silent",
    });
    if (gate.allowed) {
      await recordMessageForReplyChain(normalizedMsg, gate.context.threadSpec, botUserId);
      if (typeof updateId === "number") {
        emitTelegramLiveLocationMessageHook({
          accountId,
          msg: normalizedMsg,
          updateId,
          updateKind: kind,
          isForum,
        });
      }
    }
    return { kind: "recorded" };
  };

  return {
    handle: async (ctx) => {
      if (ctx.message) {
        return await handleMessage(ctx, "message");
      }
      if (ctx.editedMessage) {
        return await handleEditedMessage(ctx, "edited_message");
      }
      if (ctx.channelPost) {
        return await handleMessage(ctx, "channel_post");
      }
      if (ctx.editedChannelPost) {
        return await handleEditedMessage(ctx, "edited_channel_post");
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
  bot.on(["message", "edited_message", "channel_post", "edited_channel_post"], pipeline.handle);
}

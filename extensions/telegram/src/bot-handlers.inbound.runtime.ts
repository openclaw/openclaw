// Telegram inbound buffering, media resolution, and message dispatch.
import type { Message } from "grammy/types";
import {
  buildMentionRegexes,
  implicitMentionKindWhen,
  matchesMentionWithExplicit,
  resolveInboundMentionDecision,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import { isAbortRequestText } from "openclaw/plugin-sdk/command-primitives-runtime";
import type {
  DmPolicy,
  OpenClawConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { danger, logVerbose, warn } from "openclaw/plugin-sdk/runtime-env";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { firstDefined, type NormalizedAllowFrom } from "./bot-access.js";
import {
  buildTelegramInboundDebounceConversationKey,
  buildTelegramInboundDebounceKey,
} from "./bot-handlers.debounce-key.js";
import {
  isDurablyRetryableInboundMediaError,
  isMediaSizeLimitError,
  isRecoverableMediaGroupError,
  TelegramBotApiFileTooLargeError,
} from "./bot-handlers.media.js";
import type { TelegramHandlerMessageRuntime } from "./bot-handlers.message.runtime.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import type { TelegramAmbientTranscriptWatermark } from "./bot-message-context.types.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import {
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
  type TelegramSpooledReplayDeferredParticipant,
} from "./bot-processing-outcome.js";
import { MEDIA_GROUP_TIMEOUT_MS, type MediaGroupEntry } from "./bot-updates.js";
import { resolveMedia } from "./bot/delivery.resolve-media.js";
import { getTelegramTextParts, hasBotMention } from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import { isTelegramForumServiceMessage } from "./forum-service-message.js";
import { resolveTelegramCommandIngressAuthorization } from "./ingress.js";

export function createTelegramHandlerInboundRuntime(
  {
    cfg,
    accountId,
    bot,
    opts,
    runtime,
    mediaMaxBytes,
    telegramCfg,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
  }: RegisterTelegramHandlerParams,
  messageRuntime: TelegramHandlerMessageRuntime,
) {
  const {
    mediaRuntimeWithAbort,
    promptContextBoundaryOptions,
    latestPromptContextMinTimestampMs,
    latestPromptContextAmbientWatermark,
    mergeDispatchDedupeKeys,
    releaseDispatchDedupeKeys,
    buildFailedProcessingResult,
    settleSpooledReplayParticipants,
    createSpooledReplayParticipantForBufferedWork,
    spooledReplayOptions,
    buildSyntheticTextMessage,
    buildSyntheticContext,
    formatTelegramAmbientTranscriptBody,
    resolveTelegramSessionState,
    processMessageWithReplyChain,
  } = messageRuntime;
  const DEFAULT_TEXT_FRAGMENT_MAX_GAP_MS = 1500;
  const TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS = 4000;
  const TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS =
    typeof opts.testTimings?.textFragmentGapMs === "number" &&
    Number.isFinite(opts.testTimings.textFragmentGapMs)
      ? Math.max(10, Math.floor(opts.testTimings.textFragmentGapMs))
      : DEFAULT_TEXT_FRAGMENT_MAX_GAP_MS;
  const TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP = 1;
  const TELEGRAM_TEXT_FRAGMENT_MAX_PARTS = 12;
  const TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS = 50_000;
  const mediaGroupTimeoutMs =
    typeof opts.testTimings?.mediaGroupFlushMs === "number" &&
    Number.isFinite(opts.testTimings.mediaGroupFlushMs)
      ? Math.max(10, Math.floor(opts.testTimings.mediaGroupFlushMs))
      : typeof telegramCfg.mediaGroupFlushMs === "number" &&
          Number.isFinite(telegramCfg.mediaGroupFlushMs)
        ? Math.max(10, Math.floor(telegramCfg.mediaGroupFlushMs))
        : MEDIA_GROUP_TIMEOUT_MS;

  type BufferedMediaGroupEntry = MediaGroupEntry & {
    // Album mention preflight must use the same policy snapshot that admitted its first item.
    authorizationCfg: OpenClawConfig;
    storeAllowFrom: string[];
    isGroup: boolean;
    isForum: boolean;
    resolvedThreadId?: number;
    dmThreadId?: number;
    senderId: string;
    effectiveGroupAllow: NormalizedAllowFrom;
    effectiveDmAllow: NormalizedAllowFrom;
    groupConfig?: TelegramGroupConfig;
    topicConfig?: TelegramTopicConfig;
    dispatchDedupeKeys: string[];
    spooledReplayParticipants: TelegramSpooledReplayDeferredParticipant[];
  };
  const mediaGroupBuffer = new Map<string, BufferedMediaGroupEntry>();
  const mediaGroupProcessingQueue = new KeyedAsyncQueue();

  type TextFragmentEntry = {
    key: string;
    storeAllowFrom: string[];
    threadId?: number;
    messages: Array<{ msg: Message; ctx: TelegramContext; receivedAtMs: number }>;
    promptContextMinTimestampMs?: number;
    promptContextAmbientWatermark?: TelegramAmbientTranscriptWatermark;
    dispatchDedupeKeys: string[];
    spooledReplayParticipants: TelegramSpooledReplayDeferredParticipant[];
    timer: ReturnType<typeof setTimeout>;
  };
  const textFragmentBuffer = new Map<string, TextFragmentEntry>();
  const textFragmentProcessingQueue = new KeyedAsyncQueue();

  const queueBufferedProcessing = async (
    queue: KeyedAsyncQueue,
    key: string,
    task: () => Promise<void>,
  ) => {
    await queue.enqueue(key, async () => {
      await task().catch(() => undefined);
    });
  };

  const debounceMs = resolveInboundDebounceMs({ cfg, channel: "telegram" });
  const FORWARD_BURST_DEBOUNCE_MS = 80;
  type TelegramDebounceLane = "default" | "forward";
  type TelegramDebounceEntry = {
    ctx: TelegramContext;
    msg: Message;
    allMedia: TelegramMediaRef[];
    storeAllowFrom: string[];
    receivedAtMs: number;
    debounceKey: string | null;
    debounceLane: TelegramDebounceLane;
    botUsername?: string;
    threadId?: number;
    promptContextMinTimestampMs?: number;
    promptContextAmbientWatermark?: TelegramAmbientTranscriptWatermark;
    dispatchDedupeKeys: string[];
    spooledReplayParticipant?: TelegramSpooledReplayDeferredParticipant;
  };
  const resolveTelegramDebounceEntryMs = (entry: TelegramDebounceEntry): number =>
    entry.debounceLane === "forward" ? FORWARD_BURST_DEBOUNCE_MS : debounceMs;
  const shouldDebounceTelegramEntry = (entry: TelegramDebounceEntry): boolean => {
    const text = getTelegramTextParts(entry.msg).text;
    const hasDebounceableText = shouldDebounceTextInbound({
      text,
      cfg,
      commandOptions: { botUsername: entry.botUsername },
    });
    if (entry.debounceLane === "forward") {
      // Forwarded bursts often split text + media into adjacent updates.
      // Debounce media-only forward entries too so they can coalesce.
      return hasDebounceableText || entry.allMedia.length > 0;
    }
    if (!hasDebounceableText) {
      return false;
    }
    return entry.allMedia.length === 0;
  };
  const resolveTelegramDebounceLane = (msg: Message): TelegramDebounceLane => {
    const forwardMeta = msg as {
      forward_origin?: unknown;
      forward_from?: unknown;
      forward_from_chat?: unknown;
      forward_sender_name?: unknown;
      forward_date?: unknown;
    };
    return (forwardMeta.forward_origin ??
      forwardMeta.forward_from ??
      forwardMeta.forward_from_chat ??
      forwardMeta.forward_sender_name ??
      forwardMeta.forward_date)
      ? "forward"
      : "default";
  };
  const inboundDebouncer = createInboundDebouncer<TelegramDebounceEntry>({
    debounceMs,
    serializeImmediate: true,
    resolveDebounceMs: resolveTelegramDebounceEntryMs,
    buildKey: (entry) => entry.debounceKey,
    shouldDebounce: shouldDebounceTelegramEntry,
    onFlush: async (entries) => {
      const spooledReplayParticipants = entries
        .map((entry) => entry.spooledReplayParticipant)
        .filter(
          (participant): participant is TelegramSpooledReplayDeferredParticipant =>
            participant !== undefined,
        );
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      try {
        if (entries.length === 1) {
          const result = await processMessageWithReplyChain({
            ctx: last.ctx,
            msg: last.msg,
            allMedia: last.allMedia,
            storeAllowFrom: last.storeAllowFrom,
            options: {
              receivedAtMs: last.receivedAtMs,
              ingressBuffer: "inbound-debounce",
              ...promptContextBoundaryOptions(
                last.promptContextMinTimestampMs,
                last.promptContextAmbientWatermark,
              ),
              ...spooledReplayOptions(spooledReplayParticipants),
            },
            dispatchDedupeKeys: last.dispatchDedupeKeys,
            spooledReplayParticipants,
          });
          settleSpooledReplayParticipants(spooledReplayParticipants, result);
          return;
        }
        const combinedText = entries
          .map((entry) => getTelegramTextParts(entry.msg).text)
          .filter(Boolean)
          .join("\n");
        const combinedMedia = entries.flatMap((entry) => entry.allMedia);
        if (!combinedText.trim() && combinedMedia.length === 0) {
          releaseDispatchDedupeKeys(
            mergeDispatchDedupeKeys(...entries.map((entry) => entry.dispatchDedupeKeys)),
          );
          settleSpooledReplayParticipants(spooledReplayParticipants, { kind: "skipped" });
          return;
        }
        const first = expectDefined(entries.at(0), "multi-entry Telegram debounce batch");
        const promptContextMinTimestampMs = latestPromptContextMinTimestampMs(
          ...entries.map((entry) => entry.promptContextMinTimestampMs),
        );
        const promptContextAmbientWatermark = latestPromptContextAmbientWatermark(
          ...entries.map((entry) => entry.promptContextAmbientWatermark),
        );
        const baseCtx = first.ctx;
        const syntheticMessage = buildSyntheticTextMessage({
          base: first.msg,
          text: combinedText,
          date: last.msg.date ?? first.msg.date,
        });
        const messageIdOverride = last.msg.message_id ? String(last.msg.message_id) : undefined;
        const syntheticCtx = buildSyntheticContext(baseCtx, syntheticMessage);
        const result = await processMessageWithReplyChain({
          ctx: syntheticCtx,
          msg: syntheticMessage,
          allMedia: combinedMedia,
          storeAllowFrom: first.storeAllowFrom,
          options: {
            ...(messageIdOverride ? { messageIdOverride } : {}),
            ambientTranscriptBody: formatTelegramAmbientTranscriptBody(
              entries.map((entry) => entry.msg),
            ),
            receivedAtMs: first.receivedAtMs,
            ingressBuffer: "inbound-debounce",
            ...promptContextBoundaryOptions(
              promptContextMinTimestampMs,
              promptContextAmbientWatermark,
            ),
            ...spooledReplayOptions(spooledReplayParticipants),
          },
          dispatchDedupeKeys: mergeDispatchDedupeKeys(
            ...entries.map((entry) => entry.dispatchDedupeKeys),
          ),
          spooledReplayParticipants,
        });
        settleSpooledReplayParticipants(spooledReplayParticipants, result);
      } catch (err) {
        settleSpooledReplayParticipants(
          spooledReplayParticipants,
          buildFailedProcessingResult(err),
        );
        throw err;
      }
    },
    onError: (err, items) => {
      const spooledReplayParticipants = items
        .map((item) => item.spooledReplayParticipant)
        .filter(
          (participant): participant is TelegramSpooledReplayDeferredParticipant =>
            participant !== undefined,
        );
      settleSpooledReplayParticipants(spooledReplayParticipants, buildFailedProcessingResult(err));
      runtime.error?.(danger(`telegram debounce flush failed: ${String(err)}`));
      if (spooledReplayParticipants.length > 0) {
        return;
      }
      const chatId = items[0]?.msg.chat.id;
      if (chatId != null) {
        const threadId = items[0]?.msg.message_thread_id;
        void bot.api
          .sendMessage(
            chatId,
            "Something went wrong while processing your message. Please try again.",
            threadId != null ? { message_thread_id: threadId } : undefined,
          )
          .catch((sendErr: unknown) => {
            logVerbose(`telegram: error fallback send failed: ${String(sendErr)}`);
          });
      }
    },
    onCancel: (items) => {
      releaseDispatchDedupeKeys(
        mergeDispatchDedupeKeys(...items.map((item) => item.dispatchDedupeKeys)),
      );
      settleSpooledReplayParticipants(
        items
          .map((item) => item.spooledReplayParticipant)
          .filter(
            (participant): participant is TelegramSpooledReplayDeferredParticipant =>
              participant !== undefined,
          ),
        { kind: "skipped" },
      );
    },
  });

  const mediaMayNeedDownloadForMentionDetection = (msg: Message): boolean => {
    const textParts = getTelegramTextParts(msg);
    if (textParts.text.trim()) {
      return false;
    }
    const documentMime = msg.document?.mime_type?.split(";")[0]?.trim().toLowerCase();
    return Boolean(msg.audio ?? msg.voice ?? documentMime?.startsWith("audio/"));
  };

  const shouldSkipMediaDownloadForUnaddressedMentionGroup = async (params: {
    authorizationCfg: OpenClawConfig;
    ctx: TelegramContext;
    msg: Message;
    chatId: number;
    isGroup: boolean;
    isForum: boolean;
    resolvedThreadId?: number;
    dmThreadId?: number;
    senderId: string;
    effectiveGroupAllow: NormalizedAllowFrom;
    effectiveDmAllow: NormalizedAllowFrom;
    groupConfig?: TelegramGroupConfig;
    topicConfig?: TelegramTopicConfig;
  }): Promise<boolean> => {
    const {
      authorizationCfg,
      ctx,
      msg,
      chatId,
      isGroup,
      isForum,
      resolvedThreadId,
      dmThreadId,
      senderId,
      effectiveGroupAllow,
      effectiveDmAllow,
      groupConfig,
      topicConfig,
    } = params;
    if (!isGroup || mediaMayNeedDownloadForMentionDetection(msg)) {
      return false;
    }

    const runtimeCfg = authorizationCfg;
    const sessionState = resolveTelegramSessionState({
      chatId,
      isGroup,
      isForum,
      resolvedThreadId,
      messageThreadId: resolvedThreadId ?? dmThreadId,
      senderId,
      runtimeCfg,
    });
    const activationOverride = resolveGroupActivation({
      chatId,
      messageThreadId: resolvedThreadId,
      sessionKey: sessionState.sessionKey,
      agentId: sessionState.agentId,
      cfg: runtimeCfg,
    });
    const requireMention = firstDefined(
      topicConfig?.requireMention,
      activationOverride,
      groupConfig?.requireMention,
      resolveGroupRequireMention(chatId, runtimeCfg),
    );
    if (!requireMention) {
      return false;
    }

    const botUsername = ctx.me?.username?.trim().toLowerCase();
    const mentionRegexes = buildMentionRegexes(runtimeCfg, sessionState.agentId);
    const messageTextParts = getTelegramTextParts(msg);
    const hasAnyMention = messageTextParts.entities.some((ent) => ent.type === "mention");
    const explicitlyMentioned = botUsername ? hasBotMention(msg, botUsername) : false;
    const wasMentioned = matchesMentionWithExplicit({
      text: messageTextParts.text,
      mentionRegexes,
      explicit: {
        hasAnyMention,
        isExplicitlyMentioned: explicitlyMentioned,
        canResolveExplicit: Boolean(botUsername),
      },
    });
    const botId = ctx.me?.id;
    const replyFromId = msg.reply_to_message?.from?.id;
    const replyToBotMessage = botId != null && replyFromId === botId;
    const isReplyToServiceMessage =
      replyToBotMessage && isTelegramForumServiceMessage(msg.reply_to_message);
    const implicitMentionKinds = implicitMentionKindWhen(
      "reply_to_bot",
      replyToBotMessage && !isReplyToServiceMessage,
    );
    const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;
    const hasControlCommandInMessage = hasControlCommand(messageTextParts.text, runtimeCfg, {
      botUsername,
    });
    const commandGate = await resolveTelegramCommandIngressAuthorization({
      accountId,
      cfg: runtimeCfg,
      dmPolicy: "pairing",
      isGroup,
      chatId,
      resolvedThreadId,
      senderId,
      effectiveDmAllow,
      effectiveGroupAllow,
      ownerAccess: { ownerList: [], senderIsOwner: false },
      eventKind: "message",
      allowTextCommands: true,
      hasControlCommand: hasControlCommandInMessage,
      modeWhenAccessGroupsOff: "allow",
      includeDmAllowForGroupCommands: false,
    });
    const mentionDecision = resolveInboundMentionDecision({
      facts: {
        canDetectMention,
        wasMentioned,
        hasAnyMention,
        implicitMentionKinds,
      },
      policy: {
        isGroup,
        requireMention: true,
        allowTextCommands: true,
        hasControlCommand: hasControlCommandInMessage,
        commandAuthorized: commandGate.authorized,
      },
    });
    if (mentionDecision.shouldSkip) {
      logger.info({ chatId, reason: "no-mention" }, "skipping group media before download");
      return true;
    }
    return false;
  };

  const processMediaGroup = async (entry: BufferedMediaGroupEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);

      const captionMsg = entry.messages.find((m) => m.msg.caption || m.msg.text);
      const primaryEntry = captionMsg ?? entry.messages[0];
      if (!primaryEntry) {
        releaseDispatchDedupeKeys(entry.dispatchDedupeKeys);
        settleSpooledReplayParticipants(entry.spooledReplayParticipants, { kind: "skipped" });
        return;
      }

      if (
        await shouldSkipMediaDownloadForUnaddressedMentionGroup({
          authorizationCfg: entry.authorizationCfg,
          ctx: primaryEntry.ctx,
          msg: primaryEntry.msg,
          chatId: primaryEntry.msg.chat.id,
          isGroup: entry.isGroup,
          isForum: entry.isForum,
          resolvedThreadId: entry.resolvedThreadId,
          dmThreadId: entry.dmThreadId,
          senderId: entry.senderId,
          effectiveGroupAllow: entry.effectiveGroupAllow,
          effectiveDmAllow: entry.effectiveDmAllow,
          groupConfig: entry.groupConfig,
          topicConfig: entry.topicConfig,
        })
      ) {
        releaseDispatchDedupeKeys(entry.dispatchDedupeKeys);
        settleSpooledReplayParticipants(entry.spooledReplayParticipants, { kind: "skipped" });
        return;
      }

      const allMedia: TelegramMediaRef[] = [];
      const promptContextMessageSelection = new Map<string, "include" | "exclude">();
      let skippedCount = 0;
      for (const { ctx, msg } of entry.messages) {
        const sourceMessageId = String(msg.message_id);
        let media;
        try {
          media = await resolveMedia({
            ctx,
            maxBytes: mediaMaxBytes,
            ...mediaRuntimeWithAbort,
          });
        } catch (mediaErr) {
          // Only durable ingress can replay an aborted album. Classic polling keeps
          // its best-effort partial delivery so Telegram does not acknowledge a drop.
          if (
            mediaRuntimeWithAbort.abortSignal?.aborted &&
            entry.spooledReplayParticipants.length > 0
          ) {
            throw mediaErr;
          }
          if (!isRecoverableMediaGroupError(mediaErr)) {
            throw mediaErr;
          }
          runtime.log?.(
            warn(`media group: skipping photo that failed to fetch: ${String(mediaErr)}`),
          );
          promptContextMessageSelection.set(sourceMessageId, "exclude");
          skippedCount++;
          continue;
        }
        if (media) {
          allMedia.push({
            path: media.path,
            contentType: media.contentType,
            stickerMetadata: media.stickerMetadata,
            sourceMessageId,
          });
          promptContextMessageSelection.set(sourceMessageId, "include");
        } else {
          promptContextMessageSelection.set(sourceMessageId, "exclude");
          skippedCount++;
        }
      }

      if (skippedCount > 0) {
        const total = entry.messages.length;
        const wasOrWere = skippedCount === 1 ? "was" : "were";
        await withTelegramApiErrorLogging({
          operation: "sendMessage",
          runtime,
          fn: () =>
            bot.api.sendMessage(
              primaryEntry.msg.chat.id,
              `⚠️ Received ${allMedia.length} of ${total} images — ${skippedCount} could not be fetched and ${wasOrWere} skipped.`,
              {
                reply_parameters: {
                  message_id: primaryEntry.msg.message_id,
                  allow_sending_without_reply: true,
                },
              },
            ),
        }).catch(() => {});
      }

      const result = await processMessageWithReplyChain({
        ctx: primaryEntry.ctx,
        msg: primaryEntry.msg,
        allMedia,
        promptContextMessageSelection,
        storeAllowFrom: entry.storeAllowFrom,
        options: {
          ...promptContextBoundaryOptions(
            entry.promptContextMinTimestampMs,
            entry.promptContextAmbientWatermark,
          ),
          ...spooledReplayOptions(entry.spooledReplayParticipants),
        },
        dispatchDedupeKeys: entry.dispatchDedupeKeys,
        spooledReplayParticipants: entry.spooledReplayParticipants,
      });
      settleSpooledReplayParticipants(entry.spooledReplayParticipants, result);
    } catch (err) {
      releaseDispatchDedupeKeys(entry.dispatchDedupeKeys, err);
      settleSpooledReplayParticipants(
        entry.spooledReplayParticipants,
        buildFailedProcessingResult(err),
      );
      runtime.error?.(danger(`media group handler failed: ${String(err)}`));
    }
  };

  const flushTextFragments = async (entry: TextFragmentEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);

      const first = entry.messages[0];
      const last = entry.messages.at(-1);
      if (!first || !last) {
        releaseDispatchDedupeKeys(entry.dispatchDedupeKeys);
        settleSpooledReplayParticipants(entry.spooledReplayParticipants, { kind: "skipped" });
        return;
      }

      const combinedText = entry.messages.map((m) => m.msg.text ?? "").join("");
      if (!combinedText.trim()) {
        releaseDispatchDedupeKeys(entry.dispatchDedupeKeys);
        settleSpooledReplayParticipants(entry.spooledReplayParticipants, { kind: "skipped" });
        return;
      }

      const syntheticMessage = buildSyntheticTextMessage({
        base: first.msg,
        text: combinedText,
        date: last.msg.date ?? first.msg.date,
      });

      const baseCtx = first.ctx;

      const syntheticCtx = buildSyntheticContext(baseCtx, syntheticMessage);
      const result = await processMessageWithReplyChain({
        ctx: syntheticCtx,
        msg: syntheticMessage,
        allMedia: [],
        storeAllowFrom: entry.storeAllowFrom,
        options: {
          messageIdOverride: String(last.msg.message_id),
          ambientTranscriptBody: formatTelegramAmbientTranscriptBody(
            entry.messages.map((message) => message.msg),
          ),
          receivedAtMs: first.receivedAtMs,
          ingressBuffer: "text-fragment",
          ...promptContextBoundaryOptions(
            entry.promptContextMinTimestampMs,
            entry.promptContextAmbientWatermark,
          ),
          ...spooledReplayOptions(entry.spooledReplayParticipants),
        },
        dispatchDedupeKeys: entry.dispatchDedupeKeys,
        spooledReplayParticipants: entry.spooledReplayParticipants,
      });
      settleSpooledReplayParticipants(entry.spooledReplayParticipants, result);
    } catch (err) {
      releaseDispatchDedupeKeys(entry.dispatchDedupeKeys, err);
      settleSpooledReplayParticipants(
        entry.spooledReplayParticipants,
        buildFailedProcessingResult(err),
      );
      runtime.error?.(danger(`text fragment handler failed: ${String(err)}`));
    }
  };

  const queueTextFragmentFlush = async (entry: TextFragmentEntry) => {
    await queueBufferedProcessing(textFragmentProcessingQueue, entry.key, async () => {
      await flushTextFragments(entry);
    });
  };

  const runTextFragmentFlush = async (entry: TextFragmentEntry) => {
    textFragmentBuffer.delete(entry.key);
    await queueTextFragmentFlush(entry);
  };

  const scheduleTextFragmentFlush = (entry: TextFragmentEntry) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      void runTextFragmentFlush(entry);
    }, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS);
  };
  const processInboundMessage = async (params: {
    authorizationCfg: OpenClawConfig;
    ctx: TelegramContext;
    msg: Message;
    chatId: number;
    isGroup: boolean;
    isForum: boolean;
    resolvedThreadId?: number;
    dmThreadId?: number;
    dmPolicy: DmPolicy;
    storeAllowFrom: string[];
    senderId: string;
    effectiveGroupAllow: NormalizedAllowFrom;
    effectiveDmAllow: NormalizedAllowFrom;
    groupConfig?: TelegramGroupConfig;
    topicConfig?: TelegramTopicConfig;
    sendOversizeWarning: boolean;
    oversizeLogMessage: string;
    promptContextMinTimestampMs?: number;
    promptContextAmbientWatermark?: TelegramAmbientTranscriptWatermark;
    dispatchDedupeKeys: string[];
  }) => {
    const {
      authorizationCfg,
      ctx,
      msg,
      chatId,
      isGroup,
      isForum,
      resolvedThreadId,
      dmThreadId,
      dmPolicy,
      storeAllowFrom,
      senderId,
      effectiveGroupAllow,
      effectiveDmAllow,
      groupConfig,
      topicConfig,
      sendOversizeWarning,
      oversizeLogMessage,
      promptContextMinTimestampMs,
      promptContextAmbientWatermark,
      dispatchDedupeKeys,
    } = params;

    const messageText = getTelegramTextParts(msg).text;
    const botUsername = ctx.me?.username;
    const isAbortControlMessage = isAbortRequestText(messageText, { botUsername });
    let abortControlAuthorized: Promise<boolean> | undefined;
    const isAuthorizedAbortControlMessage = () => {
      if (!isAbortControlMessage || !senderId) {
        return Promise.resolve(false);
      }
      abortControlAuthorized ??= resolveTelegramCommandIngressAuthorization({
        accountId,
        cfg: authorizationCfg,
        dmPolicy,
        isGroup,
        chatId,
        resolvedThreadId,
        senderId,
        effectiveDmAllow,
        effectiveGroupAllow,
        ownerAccess: { ownerList: [], senderIsOwner: false },
        eventKind: "message",
        allowTextCommands: true,
        hasControlCommand: true,
        modeWhenAccessGroupsOff: "allow",
        includeDmAllowForGroupCommands: false,
      }).then((gate) => gate.authorized);
      return abortControlAuthorized;
    };

    // Text fragment handling - Telegram splits long pastes into multiple inbound messages (~4096 chars).
    // We buffer “near-limit” messages and append immediately-following parts.
    const text = typeof msg.text === "string" ? msg.text : undefined;
    const isCommandLike = (text ?? "").trim().startsWith("/");
    if (text && !isCommandLike && !isAbortControlMessage) {
      const nowMs = Date.now();
      const senderIdValue = msg.from?.id != null ? String(msg.from.id) : "unknown";
      // Use resolvedThreadId for forum groups, dmThreadId for DM topics
      const threadId = resolvedThreadId ?? dmThreadId;
      const key = `text:${chatId}:${threadId ?? "main"}:${senderIdValue}`;
      const existing = textFragmentBuffer.get(key);

      if (existing) {
        const last = existing.messages.at(-1);
        const lastMsgId = last?.msg.message_id;
        const lastReceivedAtMs = last?.receivedAtMs ?? nowMs;
        const idGap = typeof lastMsgId === "number" ? msg.message_id - lastMsgId : Infinity;
        const timeGapMs = nowMs - lastReceivedAtMs;
        const canAppend =
          idGap > 0 &&
          idGap <= TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP &&
          timeGapMs >= 0 &&
          timeGapMs <= TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS;

        if (canAppend) {
          const currentTotalChars = existing.messages.reduce(
            (sum, m) => sum + (m.msg.text?.length ?? 0),
            0,
          );
          const nextTotalChars = currentTotalChars + text.length;
          if (
            existing.messages.length + 1 <= TELEGRAM_TEXT_FRAGMENT_MAX_PARTS &&
            nextTotalChars <= TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS
          ) {
            const spooledReplayParticipant = createSpooledReplayParticipantForBufferedWork(
              `text-fragment:${key}:${msg.message_id}`,
            );
            if (spooledReplayParticipant) {
              existing.spooledReplayParticipants.push(spooledReplayParticipant);
            }
            existing.messages.push({ msg, ctx, receivedAtMs: nowMs });
            existing.promptContextMinTimestampMs = latestPromptContextMinTimestampMs(
              existing.promptContextMinTimestampMs,
              promptContextMinTimestampMs,
            );
            existing.promptContextAmbientWatermark = latestPromptContextAmbientWatermark(
              existing.promptContextAmbientWatermark,
              promptContextAmbientWatermark,
            );
            existing.dispatchDedupeKeys = mergeDispatchDedupeKeys(
              existing.dispatchDedupeKeys,
              dispatchDedupeKeys,
            );
            scheduleTextFragmentFlush(existing);
            return;
          }
        }

        // Not appendable (or limits exceeded): flush buffered entry first, then continue normally.
        clearTimeout(existing.timer);
        textFragmentBuffer.delete(key);
        await queueTextFragmentFlush(existing);
      }

      const shouldStart = text.length >= TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS;
      if (shouldStart) {
        const spooledReplayParticipant = createSpooledReplayParticipantForBufferedWork(
          `text-fragment:${key}:${msg.message_id}`,
        );
        const entry: TextFragmentEntry = {
          key,
          storeAllowFrom,
          messages: [{ msg, ctx, receivedAtMs: nowMs }],
          dispatchDedupeKeys,
          spooledReplayParticipants: spooledReplayParticipant ? [spooledReplayParticipant] : [],
          ...promptContextBoundaryOptions(
            promptContextMinTimestampMs,
            promptContextAmbientWatermark,
          ),
          timer: setTimeout(() => {}, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS),
        };
        textFragmentBuffer.set(key, entry);
        scheduleTextFragmentFlush(entry);
        return;
      }
    } else if (text && isAbortControlMessage && (await isAuthorizedAbortControlMessage())) {
      const senderIdLocal = msg.from?.id != null ? String(msg.from.id) : "unknown";
      const threadId = resolvedThreadId ?? dmThreadId;
      const key = `text:${chatId}:${threadId ?? "main"}:${senderIdLocal}`;
      const existing = textFragmentBuffer.get(key);
      if (existing) {
        clearTimeout(existing.timer);
        textFragmentBuffer.delete(key);
        releaseDispatchDedupeKeys(existing.dispatchDedupeKeys);
        settleSpooledReplayParticipants(existing.spooledReplayParticipants, { kind: "skipped" });
      }
    }

    // Media group handling - buffer multi-image messages
    const mediaGroupId = msg.media_group_id;
    if (mediaGroupId) {
      const threadId = resolvedThreadId ?? dmThreadId;
      const mediaGroupKey = `media:${chatId}:${threadId ?? "main"}:${mediaGroupId}`;
      const existing = mediaGroupBuffer.get(mediaGroupKey);
      if (existing) {
        const spooledReplayParticipant = createSpooledReplayParticipantForBufferedWork(
          `media-group:${mediaGroupKey}:${msg.message_id}`,
        );
        if (spooledReplayParticipant) {
          existing.spooledReplayParticipants.push(spooledReplayParticipant);
        }
        clearTimeout(existing.timer);
        existing.messages.push({ msg, ctx });
        existing.promptContextMinTimestampMs = latestPromptContextMinTimestampMs(
          existing.promptContextMinTimestampMs,
          promptContextMinTimestampMs,
        );
        existing.promptContextAmbientWatermark = latestPromptContextAmbientWatermark(
          existing.promptContextAmbientWatermark,
          promptContextAmbientWatermark,
        );
        existing.dispatchDedupeKeys = mergeDispatchDedupeKeys(
          existing.dispatchDedupeKeys,
          dispatchDedupeKeys,
        );
        existing.timer = setTimeout(() => {
          mediaGroupBuffer.delete(mediaGroupKey);
          void queueBufferedProcessing(mediaGroupProcessingQueue, mediaGroupKey, async () => {
            await processMediaGroup(existing);
          });
        }, mediaGroupTimeoutMs);
      } else {
        const spooledReplayParticipant = createSpooledReplayParticipantForBufferedWork(
          `media-group:${mediaGroupKey}:${msg.message_id}`,
        );
        const entry: BufferedMediaGroupEntry = {
          authorizationCfg,
          messages: [{ msg, ctx }],
          storeAllowFrom,
          isGroup,
          isForum,
          resolvedThreadId,
          dmThreadId,
          senderId,
          effectiveGroupAllow,
          effectiveDmAllow,
          groupConfig,
          topicConfig,
          dispatchDedupeKeys,
          spooledReplayParticipants: spooledReplayParticipant ? [spooledReplayParticipant] : [],
          ...promptContextBoundaryOptions(
            promptContextMinTimestampMs,
            promptContextAmbientWatermark,
          ),
          timer: setTimeout(() => {
            mediaGroupBuffer.delete(mediaGroupKey);
            void queueBufferedProcessing(mediaGroupProcessingQueue, mediaGroupKey, async () => {
              await processMediaGroup(entry);
            });
          }, mediaGroupTimeoutMs),
        };
        mediaGroupBuffer.set(mediaGroupKey, entry);
      }
      return;
    }

    if (
      await shouldSkipMediaDownloadForUnaddressedMentionGroup({
        authorizationCfg,
        ctx,
        msg,
        chatId,
        isGroup,
        isForum,
        resolvedThreadId,
        dmThreadId,
        senderId,
        effectiveGroupAllow,
        effectiveDmAllow,
        groupConfig,
        topicConfig,
      })
    ) {
      releaseDispatchDedupeKeys(dispatchDedupeKeys);
      return;
    }

    let media: Awaited<ReturnType<typeof resolveMedia>>;
    try {
      media = await resolveMedia({
        ctx,
        maxBytes: mediaMaxBytes,
        ...mediaRuntimeWithAbort,
      });
    } catch (mediaErr) {
      if (isMediaSizeLimitError(mediaErr)) {
        if (sendOversizeWarning) {
          const limitMb =
            mediaErr instanceof TelegramBotApiFileTooLargeError
              ? Math.min(mediaErr.limitMb, Math.round(mediaMaxBytes / (1024 * 1024)))
              : Math.round(mediaMaxBytes / (1024 * 1024));
          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            runtime,
            fn: () =>
              bot.api.sendMessage(chatId, `⚠️ File too large. Maximum size is ${limitMb}MB.`, {
                reply_parameters: {
                  message_id: msg.message_id,
                  allow_sending_without_reply: true,
                },
              }),
          }).catch(() => {});
        }
        logger.warn({ chatId, error: String(mediaErr) }, oversizeLogMessage);
        releaseDispatchDedupeKeys(dispatchDedupeKeys);
        return;
      }
      logger.warn({ chatId, error: String(mediaErr) }, "media fetch failed");
      const retryable = isDurablyRetryableInboundMediaError(mediaErr);
      if (retryable) {
        recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: mediaErr });
      }
      if (!(retryable && isTelegramSpooledReplayUpdate(ctx.update))) {
        await withTelegramApiErrorLogging({
          operation: "sendMessage",
          runtime,
          fn: () =>
            bot.api.sendMessage(chatId, "⚠️ Failed to download media. Please try again.", {
              reply_parameters: {
                message_id: msg.message_id,
                allow_sending_without_reply: true,
              },
            }),
        }).catch(() => {});
      }
      releaseDispatchDedupeKeys(dispatchDedupeKeys, retryable ? mediaErr : undefined);
      return;
    }

    // Skip sticker-only messages where the sticker was skipped (animated/video)
    // These have no media and no text content to process.
    const hasText = Boolean(getTelegramTextParts(msg).text.trim());
    if (msg.sticker && !media && !hasText) {
      logVerbose("telegram: skipping sticker-only message (unsupported sticker type)");
      releaseDispatchDedupeKeys(dispatchDedupeKeys);
      return;
    }

    const allMedia = media
      ? [
          {
            path: media.path,
            contentType: media.contentType,
            stickerMetadata: media.stickerMetadata,
          },
        ]
      : [];
    const conversationKey = buildTelegramInboundDebounceConversationKey({
      chatId,
      threadId: resolvedThreadId ?? dmThreadId,
    });
    const debounceLane = resolveTelegramDebounceLane(msg);
    const debounceKey = senderId
      ? buildTelegramInboundDebounceKey({
          accountId,
          conversationKey,
          senderId,
          debounceLane,
        })
      : null;
    if (senderId && (await isAuthorizedAbortControlMessage())) {
      for (const lane of ["default", "forward"] as const) {
        inboundDebouncer.cancelKey(
          buildTelegramInboundDebounceKey({
            accountId,
            conversationKey,
            senderId,
            debounceLane: lane,
          }),
        );
      }
    }
    const debounceEntry: TelegramDebounceEntry = {
      ctx,
      msg,
      allMedia,
      storeAllowFrom,
      receivedAtMs: Date.now(),
      debounceKey: isAbortControlMessage ? null : debounceKey,
      debounceLane,
      botUsername,
      ...promptContextBoundaryOptions(promptContextMinTimestampMs, promptContextAmbientWatermark),
      dispatchDedupeKeys,
    };
    if (
      debounceEntry.debounceKey &&
      resolveTelegramDebounceEntryMs(debounceEntry) > 0 &&
      shouldDebounceTelegramEntry(debounceEntry)
    ) {
      debounceEntry.spooledReplayParticipant = createSpooledReplayParticipantForBufferedWork(
        `inbound-debounce:${debounceEntry.debounceKey}`,
      );
    }
    await inboundDebouncer.enqueue(debounceEntry);
  };

  return { processInboundMessage };
}

export type TelegramHandlerInboundRuntime = ReturnType<typeof createTelegramHandlerInboundRuntime>;

import type { Bot } from "grammy";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  createOutboundPayloadPlan,
  createStructuredOutboundPayloadPlan,
  createMessageReceiptFromOutboundResults,
  projectOutboundPayloadPlanForDelivery,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import type { MarkdownTableMode, ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayloadDelivery } from "openclaw/plugin-sdk/interactive-runtime";
import { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import {
  buildOutboundMediaLoadOptions,
  probeVideoDimensions,
} from "openclaw/plugin-sdk/media-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import type { ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { resolveTelegramInlineButtons, type TelegramInlineButtons } from "../button-types.js";
import {
  canonicalizeTelegramPresentationPayload,
  resolveTelegramInteractiveTextFallback,
} from "../interactive-fallback.js";
import { planTelegramMediaBatches } from "../outbound-media-batches.js";
import {
  prepareTelegramOutboundMedia,
  resolveTelegramOutboundMediaSenders,
} from "../outbound-media.js";
import type { TelegramPromptContextProjectionSequence } from "../prompt-context-projection.js";
import { buildTelegramSendParams } from "../reply-parameters.js";
import { TELEGRAM_RICH_TEXT_LIMIT } from "../rich-message.js";
import { isTelegramEmptyContentError } from "../rich-plain-fallback.js";
import {
  isTelegramCaptionTooLongError,
  isTelegramPhotoLimitError,
  isTelegramVoiceMessagesForbiddenError,
} from "../send-error-predicates.js";
import {
  buildTelegramProviderDeliveryResult,
  reportTelegramProviderDelivery,
} from "../send-outbound.js";
import {
  createTelegramPreparedSender,
  createTelegramReplyRequest,
  type TelegramPreparedSender,
} from "../send-prepared.js";
import { buildInlineKeyboard, reactMessageTelegram } from "../send.js";
import { recordSentMessage } from "../sent-message-cache.js";
import { resolveTelegramTargetChatType } from "../targets.js";
import {
  planTelegramTextDeliveryPages,
  type TelegramTextDeliveryPage,
} from "../telegram-text-delivery.js";
import { emitTelegramMessageSentHooks } from "./delivery.hooks.js";
import { resolveTelegramReplyId, type TelegramThreadSpec } from "./helpers.js";
import {
  resolveReplyQuoteForSend,
  type TelegramNativeQuoteCandidateByMessageId,
} from "./native-quote.js";

type DeliveryProgress = {
  hasReplied: boolean;
  promptContext?: TelegramPromptContextProjectionSequence;
};

type TelegramReplyChannelData = {
  buttons?: TelegramInlineButtons;
  reaction?: {
    emoji?: unknown;
    replyToId?: unknown;
  };
};

type ChunkTextFn = (text: string) => TelegramTextDeliveryPage[];

function resolveReplyToForSend(
  params: { replyToId?: number; replyToMode: ReplyToMode },
  progress: DeliveryProgress,
): number | undefined {
  return params.replyToId && (params.replyToMode === "all" || !progress.hasReplied)
    ? params.replyToId
    : undefined;
}

function markReplyApplied(progress: DeliveryProgress, replyToId?: number): void {
  if (replyToId && !progress.hasReplied) {
    progress.hasReplied = true;
  }
}

function filterEmptyTelegramTextChunks(chunks: readonly TelegramTextDeliveryPage[]) {
  // Telegram rejects whitespace-only text payloads; drop them before sendMessage so
  // hook-mutated or model-emitted empty replies become a no-op instead of a 400.
  // Rich chunks gate on the rich payload: valid rich content (media/divider HTML)
  // can have an empty plain projection and must still send.
  return chunks.filter(
    (chunk) => chunk.richMessage?.blocks.length || chunk.htmlText?.trim() || chunk.plainText.trim(),
  );
}

type TextReplyParams = {
  text: string;
  replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  quote?: ReturnType<typeof resolveReplyQuoteForSend>;
  replyToId?: number;
  replyToMode: ReplyToMode;
  progress?: DeliveryProgress;
  quoteOnlyOnFirstChunk?: boolean;
};

function resolveVoiceFallbackText(reply: ReplyPayload): string | undefined {
  if (reply.text?.trim()) {
    return reply.text;
  }
  if (reply.spokenText?.trim()) {
    return reply.spokenText;
  }
  return undefined;
}

function createReplyDeliverer(
  config: DeliverRepliesParams,
  sender: TelegramPreparedSender,
  progress: DeliveryProgress,
) {
  const reportAcceptedPart = (part: TelegramPreparedSender["parts"][number], kind?: "media") =>
    reportTelegramProviderDelivery({
      message: part.result,
      messageId: part.messageId,
      fallbackChatId: config.chatId,
      successfulSendThread: config.thread ?? undefined,
      ...(kind ? { kind } : {}),
    });
  const recordMessageId = (messageId: number) =>
    recordSentMessage(config.chatId, messageId, config.cfg, {
      accountId: config.accountId,
      agentId: config.ownerAgentId,
    });
  const mediaLoader = config.mediaLoader ?? loadWebMedia;
  const chunkText: ChunkTextFn = (text) =>
    planTelegramTextDeliveryPages({
      text,
      maxChars:
        config.richMessages === true
          ? Math.min(config.textLimit, TELEGRAM_RICH_TEXT_LIMIT)
          : Math.min(config.textLimit, 4000),
      chunkMode: config.chunkMode ?? "length",
      tableMode: config.tableMode,
      richMessages: config.richMessages,
      skipEntityDetection: config.linkPreview === false,
      ...(config.textMode ? { textMode: config.textMode } : {}),
    });

  async function deliverTextReply(params: TextReplyParams): Promise<number | undefined> {
    const replyProgress = params.progress ?? progress;
    const chunks = filterEmptyTelegramTextChunks(chunkText(params.text));
    const suppressReply = chunks.length > 1 && isSingleUseReplyToMode(params.replyToMode);
    const delivered = await sender.sendText({
      pages: chunks,
      context: config.richMessages ? "sendRichMessage" : "sendMessage",
      tracking: {
        invalidate: () => replyProgress.promptContext?.invalidate(),
        onRejected: (error) =>
          config.runtime.error?.(
            danger(`telegram reply chunk rejected; continuing: ${formatErrorMessage(error)}`),
          ),
        onSilentSkip: (error) =>
          config.runtime.log?.(
            `telegram reply chunk rendered empty; skipping: ${formatErrorMessage(error)}`,
          ),
      },
      preparePage: (_index, acceptedPages) => {
        const first = acceptedPages === 0;
        const replyToMessageId = suppressReply
          ? undefined
          : resolveReplyToForSend(params, replyProgress);
        const quote = params.quoteOnlyOnFirstChunk === true && !first ? undefined : params.quote;
        const base = buildTelegramSendParams({
          replyToMessageId,
          replyQuoteMessageId: quote?.messageId,
          replyQuoteText: replyToMessageId ? quote?.text : undefined,
          replyQuotePosition: quote?.position,
          replyQuoteEntities: quote?.entities,
          thread: config.thread,
          silent: config.silent,
        });
        return {
          requestParams: (fallback) => {
            const requestParams = { ...base };
            // One rich logical page may become several plain messages. Direct
            // replies retain its native reply only on the first physical part.
            if (fallback?.index) {
              delete requestParams.reply_parameters;
              delete requestParams.reply_to_message_id;
            }
            return {
              ...requestParams,
              ...(config.linkPreview === false
                ? { link_preview_options: { is_disabled: true } }
                : {}),
              ...(first &&
              params.replyMarkup &&
              (!fallback || fallback.index === fallback.count - 1)
                ? { reply_markup: params.replyMarkup }
                : {}),
            };
          },
          delivered: () => {
            markReplyApplied(
              replyProgress,
              suppressReply && first ? params.replyToId : replyToMessageId,
            );
          },
        };
      },
      observe: async (part) => {
        const { messageId, plainText } = part;
        if (config.thread?.id !== undefined) {
          await reportAcceptedPart(part);
        }
        config.runtime.log?.(
          `telegram text delivery ok chat=${config.chatId} message=${messageId}`,
        );
        await recordMessageId(messageId);
        await replyProgress.promptContext?.accept({ messageId, text: plainText });
      },
    });
    return delivered[0]?.messageId;
  }

  async function deliverMediaReply(
    params: Omit<TextReplyParams, "text" | "quoteOnlyOnFirstChunk"> & {
      reply: ReplyPayload;
      mediaList: string[];
    },
  ): Promise<{
    firstDeliveredMessageId?: number;
    visibleFallbackText?: string;
    mediaUrls: string[];
  }> {
    let firstDeliveredMessageId: number | undefined;
    let visibleFallbackText: string | undefined;
    let firstDeliveredCaption: string | undefined;
    const mediaUrls: string[] = [];
    const observeMedia = async (
      part: TelegramPreparedSender["parts"][number],
      captionRemoved?: true,
    ) => {
      const { result: message, messageId, plainText } = part;
      if (config.thread?.id !== undefined) {
        await reportAcceptedPart(part, "media");
      }
      firstDeliveredMessageId ??= messageId;
      firstDeliveredCaption ??= plainText || undefined;
      if (captionRemoved) {
        visibleFallbackText = "";
      }
      await recordMessageId(messageId);
      await progress.promptContext?.accept({
        messageId,
        message,
        ...(plainText ? { text: plainText } : {}),
      });
    };
    const deliverAcceptedMedia = async (
      options: Parameters<TelegramPreparedSender["sendMedia"]>[0] & { mediaUrl: string },
    ) => {
      const delivery = await sender.sendMedia(options);
      await sender.accept(delivery, (part) => observeMedia(part, delivery.captionRemoved), {
        mediaUrls: [options.mediaUrl],
      });
      mediaUrls.push(options.mediaUrl);
    };
    const prepareMedia = async (mediaUrl: string, index: number) => {
      const isFirstMedia = index === 0;
      const media = await mediaLoader(
        mediaUrl,
        buildOutboundMediaLoadOptions({
          mediaLocalRoots: config.mediaLocalRoots,
          maxBytes: config.mediaMaxBytes,
        }),
      );
      const mediaPlan = prepareTelegramOutboundMedia({
        media,
        text: isFirstMedia ? (params.reply.text ?? undefined) : undefined,
        textMode: config.textMode,
        tableMode: config.tableMode,
        preparedHtml: true,
      });
      const { sender: mediaSender, documentSender } = resolveTelegramOutboundMediaSenders({
        api: config.bot.api,
        chatId: config.chatId,
        media,
        plan: mediaPlan,
        asVoice: params.reply.audioAsVoice,
      });
      return { index, mediaUrl, media, mediaPlan, mediaSender, documentSender };
    };
    type PreparedMedia = Awaited<ReturnType<typeof prepareMedia>>;
    const deliverMediaBatch = async (batch: [PreparedMedia, ...PreparedMedia[]]): Promise<void> => {
      const { index, mediaUrl, media, mediaPlan, mediaSender, documentSender } = batch[0];
      const isFirstMedia = index === 0;
      const { htmlCaption, plainCaption, followUpText } = mediaPlan;
      const replyToMessageId = resolveReplyToForSend(params, progress);
      const shouldAttachButtonsToMedia = isFirstMedia && params.replyMarkup && !followUpText;
      const videoDimensions =
        mediaPlan.kind === "video" ? await probeVideoDimensions(media.buffer) : undefined;
      const mediaParams: Record<string, unknown> = {
        caption: htmlCaption,
        ...(htmlCaption ? { parse_mode: "HTML" } : {}),
        ...(shouldAttachButtonsToMedia ? { reply_markup: params.replyMarkup } : {}),
        ...(videoDimensions
          ? { width: videoDimensions.width, height: videoDimensions.height }
          : {}),
        ...buildTelegramSendParams({
          replyToMessageId,
          replyQuoteMessageId: params.quote?.messageId,
          replyQuoteText: params.quote?.text,
          replyQuotePosition: params.quote?.position,
          replyQuoteEntities: params.quote?.entities,
          thread: config.thread,
          silent: config.silent,
        }),
      };
      if (batch.length > 1) {
        let album: Awaited<ReturnType<TelegramPreparedSender["sendPhotoAlbum"]>>;
        try {
          album = await sender.sendPhotoAlbum({
            files: batch.map((item) => item.mediaPlan.file),
            requestParams: mediaParams,
            plainCaption,
          });
        } catch (error) {
          if (!isTelegramPhotoLimitError(error)) {
            throw error;
          }
          // A rejected album accepted no messages. Singleton sends retain the
          // existing photo-to-document recovery without retrying uncertain sends.
          mediaPlan.followUpText = undefined;
          batch.reduce((_previous, item) => item).mediaPlan.followUpText = followUpText;
          for (const item of batch) {
            await deliverMediaBatch([item]);
          }
          return;
        }
        await sender.acceptMany(album.parts, (part) => observeMedia(part, album.captionRemoved), {
          mediaUrls: batch.map((item) => item.mediaUrl),
          partialDeliveryResult: () => ({
            receipt: createMessageReceiptFromOutboundResults({
              results: album.parts.map((part) =>
                buildTelegramProviderDeliveryResult({
                  message: part.result,
                  messageId: part.result.message_id,
                  fallbackChatId: config.chatId,
                  ...(config.thread ? { successfulSendThread: config.thread } : {}),
                  kind: "media",
                }),
              ),
              kind: "media",
            }),
            visibleReplySent: true,
          }),
        });
        mediaUrls.push(...batch.map((item) => item.mediaUrl));
      } else if (mediaSender.label === "voice") {
        const sendVoiceMedia = async (requestParams: typeof mediaParams) => {
          const hasCaption = typeof requestParams.caption === "string";
          await deliverAcceptedMedia({
            sender: mediaSender,
            mediaUrl,
            requestParams,
            plainCaption: hasCaption ? plainCaption : undefined,
          });
        };
        const sendVoiceFallbackText = async (
          text: string,
          options: { replyToId?: number; includeQuote?: boolean; replyToMode?: ReplyToMode } = {},
        ) =>
          await deliverTextReply({
            ...params,
            text,
            replyToId: options.replyToId,
            quote: options.includeQuote ? params.quote : undefined,
            replyToMode: options.replyToMode ?? params.replyToMode,
            progress: { ...progress, hasReplied: false },
            quoteOnlyOnFirstChunk: true,
          });

        await config.onVoiceRecording?.();
        try {
          await sendVoiceMedia(mediaParams);
        } catch (voiceErr) {
          if (isChannelPartialDeliveryError(voiceErr)) {
            throw voiceErr;
          }
          if (isTelegramVoiceMessagesForbiddenError(voiceErr)) {
            const fallbackText = resolveVoiceFallbackText(params.reply);
            if (!fallbackText) {
              throw voiceErr;
            }
            logVerbose(
              "telegram sendVoice forbidden (recipient has voice messages blocked in privacy settings); falling back to text",
            );
            const voiceFallbackReplyTo = resolveReplyToForSend(params, progress);
            const fallbackMessageId = await sendVoiceFallbackText(fallbackText, {
              replyToId: voiceFallbackReplyTo,
              includeQuote: true,
            });
            if (fallbackMessageId === undefined) {
              throw voiceErr;
            }
            firstDeliveredMessageId ??= fallbackMessageId;
            visibleFallbackText = fallbackText;
            markReplyApplied(progress, voiceFallbackReplyTo);
            return;
          }
          if (isTelegramCaptionTooLongError(voiceErr)) {
            logVerbose(
              "telegram sendVoice caption too long; resending voice without caption + text separately",
            );
            const noCaptionParams = { ...mediaParams };
            delete noCaptionParams.caption;
            delete noCaptionParams.parse_mode;
            await sendVoiceMedia(noCaptionParams);
            const fallbackText = resolveVoiceFallbackText(params.reply);
            if (fallbackText) {
              try {
                const fallbackMessageId = await sendVoiceFallbackText(fallbackText, {
                  replyToMode: "first",
                });
                if (fallbackMessageId !== undefined) {
                  visibleFallbackText = fallbackText;
                }
              } catch (fallbackError) {
                if (
                  isChannelPartialDeliveryError(fallbackError) ||
                  !isTelegramEmptyContentError(fallbackError)
                ) {
                  throw fallbackError;
                }
                visibleFallbackText = "";
              }
            }
            markReplyApplied(progress, replyToMessageId);
            return;
          }
          throw voiceErr;
        }
      } else {
        await deliverAcceptedMedia({
          sender: mediaSender,
          documentSender,
          mediaUrl,
          requestParams: mediaParams,
          plainCaption,
        });
      }
      markReplyApplied(progress, replyToMessageId);
      if (followUpText) {
        try {
          const followUpMessageId = await deliverTextReply({
            ...params,
            text: followUpText,
            quote: undefined,
          });
          if (followUpMessageId === undefined) {
            visibleFallbackText = firstDeliveredCaption ?? "";
          } else {
            visibleFallbackText = undefined;
          }
        } catch (error) {
          if (isChannelPartialDeliveryError(error) || !isTelegramEmptyContentError(error)) {
            throw error;
          }
          visibleFallbackText = firstDeliveredCaption ?? "";
          if (params.replyMarkup && firstDeliveredMessageId !== undefined) {
            await config.bot.api.editMessageReplyMarkup(config.chatId, firstDeliveredMessageId, {
              reply_markup: params.replyMarkup,
            });
          }
        }
      }
    };
    for await (const batch of planTelegramMediaBatches({
      mediaUrls: params.mediaList,
      prepare: prepareMedia,
      // Albums do not accept reply_markup; retain the existing control-bearing sends.
      canGroup: (item) => item.mediaSender.label === "photo" && !params.replyMarkup,
    })) {
      await deliverMediaBatch(batch);
    }
    return { firstDeliveredMessageId, visibleFallbackText, mediaUrls };
  }
  return { deliverTextReply, deliverMediaReply };
}

async function maybePinFirstDeliveredMessage(params: {
  pin: ReplyPayloadDelivery["pin"];
  bot: Bot;
  chatId: string;
  firstDeliveredMessageId?: number;
}): Promise<void> {
  const shouldPin = params.pin === true || (typeof params.pin === "object" && params.pin.enabled);
  if (!shouldPin || typeof params.firstDeliveredMessageId !== "number") {
    return;
  }
  const notify = typeof params.pin === "object" && params.pin.notify === true;
  try {
    await params.bot.api.pinChatMessage(params.chatId, params.firstDeliveredMessageId, {
      disable_notification: !notify,
    });
  } catch (err) {
    if (typeof params.pin === "object" && params.pin.required === true) {
      throw err;
    }
    logVerbose(
      `telegram pinChatMessage failed chat=${params.chatId} message=${params.firstDeliveredMessageId}: ${formatErrorMessage(err)}`,
    );
  }
}

type DeliverRepliesParams = {
  replies: ReplyPayload[];
  cfg?: import("openclaw/plugin-sdk/config-contracts").OpenClawConfig;
  ownerAgentId?: string;
  chatId: string;
  accountId?: string;
  sessionKeyForInternalHooks?: string;
  policySessionKey?: string;
  mirrorIsGroup?: boolean;
  mirrorGroupId?: string;
  token: string;
  runtime: RuntimeEnv;
  bot: Bot;
  mediaLocalRoots?: readonly string[];
  mediaMaxBytes?: number;
  replyToMode: ReplyToMode;
  textLimit: number;
  thread?: TelegramThreadSpec | null;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
  /** Opt into Telegram Bot API 10.3 rich text delivery. */
  richMessages?: boolean;
  /** Callback invoked before sending a voice message to switch typing indicator. */
  onVoiceRecording?: () => Promise<void> | void;
  /** Controls whether link previews are shown. Default: true (previews enabled). */
  linkPreview?: boolean;
  /** When true, messages are sent with disable_notification. */
  silent?: boolean;
  /** Message id that the optional quote text belongs to. */
  replyQuoteMessageId?: number;
  /** Optional quote text for Telegram reply_parameters. */
  replyQuoteText?: string;
  /** UTF-16 position of the selected quote in the original Telegram message. */
  replyQuotePosition?: number;
  /** Telegram entities that belong to the selected quote text. */
  replyQuoteEntities?: unknown[];
  /** Native Telegram quote candidates keyed by message id. */
  replyQuoteByMessageId?: TelegramNativeQuoteCandidateByMessageId;
  /** Override media loader (tests). */
  mediaLoader?: typeof loadWebMedia;
  transcriptMirror?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void> | void;
  promptContextSequence?: TelegramPromptContextProjectionSequence;
  /** Text is already prepared Telegram HTML and must not be parsed as Markdown again. */
  textMode?: "html";
  /** @internal Revalidate custody at the existing send-operation boundary. */
  onPlatformSendDispatch?: () => Promise<void>;
  /** @internal Synchronously fence custody after revalidation and before Telegram I/O. */
  assertPlatformSendAuthorized?: () => void;
  /** Media refs accepted by the provider, before fallible delivery observers. */
  onMediaAccepted?: (mediaUrls: readonly string[]) => void;
};

export async function deliverReplies(
  params: DeliverRepliesParams,
): Promise<{ delivered: boolean; receipt?: MessageReceipt }> {
  return deliverReplyPlan(params, (replies) =>
    createOutboundPayloadPlan(replies, {
      cfg: params.cfg,
      sessionKey: params.policySessionKey ?? params.sessionKeyForInternalHooks,
      surface: "telegram",
    }),
  );
}

export async function deliverStructuredReplies(
  params: DeliverRepliesParams,
): Promise<{ delivered: boolean; receipt?: MessageReceipt }> {
  return deliverReplyPlan(params, createStructuredOutboundPayloadPlan);
}

async function deliverReplyPlan(
  params: DeliverRepliesParams,
  createPlan: (replies: ReplyPayload[]) => ReturnType<typeof createOutboundPayloadPlan>,
): Promise<{ delivered: boolean; receipt?: MessageReceipt }> {
  const progress: DeliveryProgress = {
    hasReplied: false,
    ...(params.promptContextSequence ? { promptContext: params.promptContextSequence } : {}),
  };
  const transcriptMirror = params.transcriptMirror;
  const deliveredContents: Array<{ text: string; mediaUrls: string[] }> = [];
  const hookRunner = getGlobalHookRunner();
  const hasMessageSendingHooks = hookRunner?.hasHooks("message_sending") ?? false;
  const candidateReplies: ReplyPayload[] = [];
  for (const reply of params.replies) {
    if (!reply || typeof reply !== "object") {
      params.runtime.error?.(danger("reply missing text/media"));
      continue;
    }
    candidateReplies.push(reply);
  }
  const normalizedReplies = projectOutboundPayloadPlanForDelivery(createPlan(candidateReplies));
  const sender = createTelegramPreparedSender({
    api: params.bot.api,
    chatId: params.chatId,
    request: createTelegramReplyRequest(params.runtime),
    warn: (message) => params.runtime.log?.(message),
    beforeTextPage: params.onPlatformSendDispatch,
    beforeMedia: params.onPlatformSendDispatch,
    assertPlatformSendAuthorized: params.assertPlatformSendAuthorized,
    onMediaAccepted: params.onMediaAccepted,
  });
  const { deliverTextReply, deliverMediaReply } = createReplyDeliverer(params, sender, progress);
  let deliveredReactions = 0;
  const deliveredCount = () => sender.parts.length + deliveredReactions;
  const buildDeliveryReceipt = () => {
    const receipt = createMessageReceiptFromOutboundResults({
      results: sender.parts.map((part) =>
        buildTelegramProviderDeliveryResult({
          message: part.result,
          messageId: part.messageId,
          fallbackChatId: params.chatId,
          ...(params.thread ? { successfulSendThread: params.thread } : {}),
        }),
      ),
    });
    for (const [index, part] of receipt.parts.entries()) {
      part.index = index;
    }
    return receipt;
  };

  for (const originalReply of normalizedReplies) {
    let reply = canonicalizeTelegramPresentationPayload(originalReply, {
      allowWebAppButtons: resolveTelegramTargetChatType(params.chatId) === "direct",
      // HTML-mode text bypasses the markdown -> rich-block converter, so native
      // table rendering only applies to the rich markdown funnel.
      richTables: params.richMessages === true && params.textMode !== "html",
    });
    const mediaList = reply.mediaUrls?.length
      ? reply.mediaUrls
      : reply.mediaUrl
        ? [reply.mediaUrl]
        : [];
    const hasMedia = mediaList.length > 0;
    const presentation = normalizeMessagePresentation(reply.presentation);
    const interactive = reply.interactive;
    const resolvedReplyText =
      resolveTelegramInteractiveTextFallback({
        text: reply.text,
        interactive,
        presentation,
      }) ??
      reply.text ??
      "";
    if (resolvedReplyText !== (reply.text ?? "")) {
      reply = { ...reply, text: resolvedReplyText };
    }
    const telegramData = reply.channelData?.telegram as TelegramReplyChannelData | undefined;
    const reactionEmoji =
      typeof telegramData?.reaction?.emoji === "string" ? telegramData.reaction.emoji : undefined;
    const replyToMode =
      params.replyToMode === "off" && (reply.replyToTag === true || reply.replyToCurrent === true)
        ? "all"
        : params.replyToMode;
    const replyToId = replyToMode === "off" ? undefined : resolveTelegramReplyId(reply.replyToId);
    const targetId = parseStrictPositiveInteger(telegramData?.reaction?.replyToId ?? replyToId);
    if (reactionEmoji && typeof targetId !== "number") {
      params.runtime.error?.(danger("Telegram reaction requires a reply target"));
      continue;
    }
    if (!resolvedReplyText && !hasMedia && !reactionEmoji) {
      if (reply.audioAsVoice) {
        logVerbose("telegram reply has audioAsVoice without media/text; skipping");
        continue;
      }
      params.runtime.error?.(danger("reply missing text/media"));
      continue;
    }

    const rawContent = resolvedReplyText;
    const spokenHookContent =
      !rawContent && reply.audioAsVoice === true && reply.spokenText?.trim()
        ? reply.spokenText
        : undefined;
    const hookContent = spokenHookContent ?? rawContent;
    const replyQuote = resolveReplyQuoteForSend({
      replyToId,
      replyQuoteByMessageId: params.replyQuoteByMessageId,
      replyQuoteMessageId: params.replyQuoteMessageId,
      replyQuoteText: params.replyQuoteText,
      replyQuotePosition: params.replyQuotePosition,
      replyQuoteEntities: params.replyQuoteEntities,
    });
    if (hasMessageSendingHooks) {
      const hookResult = await hookRunner?.runMessageSending(
        {
          to: params.chatId,
          content: hookContent,
          replyToId,
          threadId: params.thread?.id,
          metadata: {
            channel: "telegram",
            mediaUrls: mediaList,
            threadId: params.thread?.id,
          },
        },
        {
          channelId: "telegram",
          accountId: params.accountId,
          conversationId: params.chatId,
        },
      );
      if (hookResult?.cancel) {
        continue;
      }
      if (typeof hookResult?.content === "string" && hookResult.content !== hookContent) {
        // Hook-mutated content is not a projection of the tagged transcript.
        // Detach before recording the concrete Telegram send.
        progress.promptContext?.detach();
        reply = spokenHookContent
          ? { ...reply, spokenText: hookResult.content }
          : { ...reply, text: hookResult.content };
      }
    }

    let contentForSentHook =
      reply.text || (reply.audioAsVoice === true ? resolveVoiceFallbackText(reply) : "") || "";
    const sentHookContext = {
      sessionKeyForInternalHooks: params.sessionKeyForInternalHooks,
      chatId: params.chatId,
      accountId: params.accountId,
      isGroup: params.mirrorIsGroup,
      groupId: params.mirrorGroupId,
    };

    try {
      const deliveredCountBeforeReply = deliveredCount();
      const replyMarkup = buildInlineKeyboard(
        resolveTelegramInlineButtons({
          buttons: telegramData?.buttons,
          presentation,
          interactive,
        }),
      );
      let firstDeliveredMessageId: number | undefined;
      let deliveredMediaUrls: string[] = [];
      if (reactionEmoji && typeof targetId === "number") {
        await params.onPlatformSendDispatch?.();
        params.assertPlatformSendAuthorized?.();
        const reactionResult = await reactMessageTelegram(params.chatId, targetId, reactionEmoji, {
          cfg: params.cfg ?? { channels: { telegram: { botToken: params.token } } },
          token: params.token,
          accountId: params.accountId,
          api: params.bot.api,
          verbose: false,
        });
        if (reactionResult.ok) {
          deliveredReactions += 1;
        } else {
          params.runtime.error?.(danger(reactionResult.warning));
          continue;
        }
      }
      const textReply: TextReplyParams = {
        text: reply.text || "",
        replyMarkup,
        quote: replyQuote,
        replyToId,
        replyToMode,
      };
      if (mediaList.length === 0 && resolvedReplyText) {
        firstDeliveredMessageId = await deliverTextReply(textReply);
      } else if (mediaList.length > 0) {
        const mediaDelivery = await deliverMediaReply({
          ...textReply,
          reply,
          mediaList,
        });
        firstDeliveredMessageId = mediaDelivery.firstDeliveredMessageId;
        deliveredMediaUrls = mediaDelivery.mediaUrls;
        if (mediaDelivery.visibleFallbackText !== undefined) {
          contentForSentHook = mediaDelivery.visibleFallbackText;
        }
      }
      await maybePinFirstDeliveredMessage({
        pin: reply.delivery?.pin,
        bot: params.bot,
        chatId: params.chatId,
        firstDeliveredMessageId,
      });

      if (deliveredCount() > deliveredCountBeforeReply && transcriptMirror) {
        deliveredContents.push({ text: contentForSentHook, mediaUrls: deliveredMediaUrls });
      }

      emitTelegramMessageSentHooks({
        ...sentHookContext,
        content: contentForSentHook,
        success: deliveredCount() > deliveredCountBeforeReply,
        messageId: firstDeliveredMessageId,
      });
    } catch (error) {
      emitTelegramMessageSentHooks({
        ...sentHookContext,
        content: contentForSentHook,
        success: false,
        error: formatErrorMessage(error),
      });
      sender.fail(
        error,
        0,
        sender.parts.length
          ? { receipt: buildDeliveryReceipt(), visibleReplySent: true }
          : undefined,
      );
    }
  }

  if (deliveredCount() > 0 && transcriptMirror) {
    const text = deliveredContents
      .map((content) => content.text)
      .filter(Boolean)
      .join("\n\n");
    const mediaUrls = deliveredContents.flatMap((content) => content.mediaUrls);
    if (text || mediaUrls.length > 0) {
      try {
        await transcriptMirror({
          text: text || undefined,
          mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
        });
      } catch (mirrorErr) {
        logVerbose(`telegram transcriptMirror failed: ${formatErrorMessage(mirrorErr)}`);
      }
    }
  }

  return {
    delivered: deliveredCount() > 0,
    ...(sender.parts.length ? { receipt: buildDeliveryReceipt() } : {}),
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

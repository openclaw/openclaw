import { type Bot, GrammyError, InputFile, InputMediaBuilder } from "grammy";
import type { InputMediaPhoto, InputMediaVideo } from "grammy/types";
import type { ReplyToMode } from "openclaw/plugin-sdk/config-runtime";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-runtime";
import { fireAndForgetHook } from "openclaw/plugin-sdk/hook-runtime";
import { createInternalHookEvent, triggerInternalHook } from "openclaw/plugin-sdk/hook-runtime";
import {
  buildCanonicalSentMessageHookContext,
  toInternalMessageSentContext,
  toPluginMessageContext,
  toPluginMessageSentEvent,
} from "openclaw/plugin-sdk/hook-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/infra-runtime";
import { buildOutboundMediaLoadOptions } from "openclaw/plugin-sdk/media-runtime";
import { isGifMedia, kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import type { TelegramInlineButtons } from "../button-types.js";
import { splitTelegramCaption } from "../caption.js";
import {
  markdownToTelegramChunks,
  markdownToTelegramHtml,
  renderTelegramHtmlText,
  wrapFileReferencesInHtml,
} from "../format.js";
import { buildInlineKeyboard } from "../send.js";
import { resolveTelegramVoiceSend } from "../voice.js";
import {
  buildTelegramSendParams,
  sendTelegramMediaGroup,
  sendTelegramText,
  sendTelegramWithThreadFallback,
} from "./delivery.send.js";
import { resolveTelegramReplyId, type TelegramThreadSpec } from "./helpers.js";
import {
  markReplyApplied,
  resolveReplyToForSend,
  sendChunkedTelegramReplyText,
  type DeliveryProgress as ReplyThreadDeliveryProgress,
} from "./reply-threading.js";

const VOICE_FORBIDDEN_RE = /VOICE_MESSAGES_FORBIDDEN/;
const CAPTION_TOO_LONG_RE = /caption is too long/i;

type DeliveryProgress = ReplyThreadDeliveryProgress & {
  deliveredCount: number;
};

type TelegramReplyChannelData = {
  buttons?: TelegramInlineButtons;
  pin?: boolean;
};

type ChunkTextFn = (markdown: string) => ReturnType<typeof markdownToTelegramChunks>;

function buildChunkTextResolver(params: {
  textLimit: number;
  chunkMode: ChunkMode;
  tableMode?: MarkdownTableMode;
}): ChunkTextFn {
  return (markdown: string) => {
    const markdownChunks =
      params.chunkMode === "newline"
        ? chunkMarkdownTextWithMode(markdown, params.textLimit, params.chunkMode)
        : [markdown];
    const chunks: ReturnType<typeof markdownToTelegramChunks> = [];
    for (const chunk of markdownChunks) {
      const nested = markdownToTelegramChunks(chunk, params.textLimit, {
        tableMode: params.tableMode,
      });
      if (!nested.length && chunk) {
        chunks.push({
          html: wrapFileReferencesInHtml(
            markdownToTelegramHtml(chunk, { tableMode: params.tableMode, wrapFileRefs: false }),
          ),
          text: chunk,
        });
        continue;
      }
      chunks.push(...nested);
    }
    return chunks;
  };
}

function markDelivered(progress: DeliveryProgress): void {
  progress.hasDelivered = true;
  progress.deliveredCount += 1;
}

const MEDIA_GROUP_MIN = 2;
const MEDIA_GROUP_MAX = 10;

/**
 * Wraps a media loader with an in-memory cache keyed by URL so that media
 * downloaded during the album groupability check can be reused by the per-item
 * fallback without a second download.
 */
function createCachingMediaLoader(base: typeof loadWebMedia): typeof loadWebMedia {
  const cache = new Map<string, Awaited<ReturnType<typeof loadWebMedia>>>();
  return async (url, ...rest) => {
    const cached = cache.get(url);
    if (cached) return cached;
    const result = await base(url, ...rest);
    cache.set(url, result);
    return result;
  };
}

type GroupableMediaKind = "image" | "video";

/** Returns true when the item count is in the 2-10 range and audioAsVoice is not requested.
 *  MIME-level groupability (photos/videos only) is validated lazily during media loading. */
function isGroupableMediaList(mediaList: string[], reply: ReplyPayload): boolean {
  if (reply.audioAsVoice) return false;
  return mediaList.length >= MEDIA_GROUP_MIN && mediaList.length <= MEDIA_GROUP_MAX;
}

/**
 * Sends 2-10 photos/videos as a single Telegram album via sendMediaGroup.
 * Caption is placed on the first item (subject to 1024-char limit).
 * Buttons and overflow text are sent as follow-up messages because
 * sendMediaGroup does not support reply_markup.
 *
 * Returns the first delivered message_id, or undefined on empty delivery.
 * Returns `null` when the loaded media turns out to be non-groupable
 * (e.g. GIF, audio, document) so the caller can fall back to per-item delivery.
 */
async function deliverMediaGroupReply(params: {
  reply: ReplyPayload;
  mediaList: string[];
  bot: Bot;
  chatId: string;
  runtime: RuntimeEnv;
  thread?: TelegramThreadSpec | null;
  tableMode?: MarkdownTableMode;
  mediaLocalRoots?: readonly string[];
  chunkText: ChunkTextFn;
  mediaLoader: typeof loadWebMedia;
  linkPreview?: boolean;
  silent?: boolean;
  replyQuoteText?: string;
  replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  replyToId?: number;
  replyToMode: ReplyToMode;
  progress: DeliveryProgress;
}): Promise<number | undefined | null> {
  // Load all media and build InputMedia entries, bailing out if any item
  // is not a groupable type (photo/video). Note: sendMediaGroup requires
  // all items at once, so all buffers are held concurrently. This is an
  // inherent trade-off of album delivery vs the per-item path which holds
  // one buffer at a time.
  const inputMedia: Array<InputMediaPhoto | InputMediaVideo> = [];
  for (let i = 0; i < params.mediaList.length; i++) {
    const mediaUrl = params.mediaList[i]!;
    const media = await params.mediaLoader(
      mediaUrl,
      buildOutboundMediaLoadOptions({ mediaLocalRoots: params.mediaLocalRoots }),
    );
    const kind = kindFromMime(media.contentType ?? undefined) as
      | GroupableMediaKind
      | string
      | undefined;
    const isGif = isGifMedia({
      contentType: media.contentType,
      fileName: media.fileName,
    });
    // GIFs, audio, documents, and unknown types are not groupable.
    if (isGif || (kind !== "image" && kind !== "video")) {
      return null;
    }
    const fileName = media.fileName ?? "file";
    const file = new InputFile(media.buffer, fileName);

    // Caption is only attached to the first item in the group.
    let captionOpts: { caption?: string; parse_mode?: "HTML" } = {};
    if (i === 0) {
      const { caption } = splitTelegramCaption(params.reply.text ?? undefined);
      if (caption) {
        const htmlCaption = renderTelegramHtmlText(caption, { tableMode: params.tableMode });
        captionOpts = { caption: htmlCaption, parse_mode: "HTML" };
      }
    }

    if (kind === "video") {
      inputMedia.push(InputMediaBuilder.video(file, captionOpts));
    } else {
      inputMedia.push(InputMediaBuilder.photo(file, captionOpts));
    }
  }

  const replyToMessageId = resolveReplyToForSend({
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
    progress: params.progress,
  });

  // Resolve the follow-up reply target BEFORE sending the album and marking
  // the reply applied, so that replyToMode "first" still threads the button
  // carrier message alongside the album.
  const followUpReplyTo = resolveReplyToForSend({
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
    progress: params.progress,
  });

  const firstMessageId = await sendTelegramMediaGroup({
    bot: params.bot,
    chatId: params.chatId,
    media: inputMedia,
    runtime: params.runtime,
    thread: params.thread,
    replyToMessageId: followUpReplyTo,
    silent: params.silent,
  });

  // Mark all items as delivered.
  for (let i = 0; i < inputMedia.length; i++) {
    markDelivered(params.progress);
  }
  markReplyApplied(params.progress, followUpReplyTo);

  // Handle caption overflow and/or buttons as follow-up messages.
  // sendMediaGroup does not support reply_markup, so buttons must go in a
  // separate follow-up message.
  const { followUpText } = splitTelegramCaption(params.reply.text ?? undefined);
  if (followUpText) {
    await sendPendingFollowUpText({
      bot: params.bot,
      chatId: params.chatId,
      runtime: params.runtime,
      thread: params.thread,
      chunkText: params.chunkText,
      text: followUpText,
      replyMarkup: params.replyMarkup,
      linkPreview: params.linkPreview,
      silent: params.silent,
      replyToId: params.replyToId,
      replyToMode: params.replyToMode,
      progress: params.progress,
    });
  } else if (params.replyMarkup) {
    // No caption overflow, but buttons need a carrier message since
    // sendMediaGroup does not support reply_markup. Use the caption text
    // (already shown on the album) so callback handlers receive the
    // originating message text via callback.messageText.
    // followUpReplyTo was resolved before markReplyApplied, so it is
    // available even when replyToMode is "first".
    const { caption: carrierText } = splitTelegramCaption(params.reply.text ?? undefined);
    const carrierHtml = carrierText
      ? renderTelegramHtmlText(carrierText, { tableMode: params.tableMode })
      : "\u200B";
    await sendTelegramText(params.bot, params.chatId, carrierHtml, params.runtime, {
      replyToMessageId: followUpReplyTo,
      replyQuoteText: params.replyQuoteText,
      thread: params.thread,
      textMode: "html",
      plainText: carrierText || "\u200B",
      linkPreview: params.linkPreview ?? false,
      silent: params.silent,
      replyMarkup: params.replyMarkup,
    });
    markReplyApplied(params.progress, followUpReplyTo);
    markDelivered(params.progress);
  }

  return firstMessageId;
}

async function deliverTextReply(params: {
  bot: Bot;
  chatId: string;
  runtime: RuntimeEnv;
  thread?: TelegramThreadSpec | null;
  chunkText: ChunkTextFn;
  replyText: string;
  replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  replyQuoteText?: string;
  linkPreview?: boolean;
  silent?: boolean;
  replyToId?: number;
  replyToMode: ReplyToMode;
  progress: DeliveryProgress;
}): Promise<number | undefined> {
  let firstDeliveredMessageId: number | undefined;
  await sendChunkedTelegramReplyText({
    chunks: params.chunkText(params.replyText),
    progress: params.progress,
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
    replyMarkup: params.replyMarkup,
    replyQuoteText: params.replyQuoteText,
    markDelivered,
    sendChunk: async ({ chunk, replyToMessageId, replyMarkup, replyQuoteText }) => {
      const messageId = await sendTelegramText(
        params.bot,
        params.chatId,
        chunk.html,
        params.runtime,
        {
          replyToMessageId,
          replyQuoteText,
          thread: params.thread,
          textMode: "html",
          plainText: chunk.text,
          linkPreview: params.linkPreview,
          silent: params.silent,
          replyMarkup,
        },
      );
      if (firstDeliveredMessageId == null) {
        firstDeliveredMessageId = messageId;
      }
    },
  });
  return firstDeliveredMessageId;
}

async function sendPendingFollowUpText(params: {
  bot: Bot;
  chatId: string;
  runtime: RuntimeEnv;
  thread?: TelegramThreadSpec | null;
  chunkText: ChunkTextFn;
  text: string;
  replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  linkPreview?: boolean;
  silent?: boolean;
  replyToId?: number;
  replyToMode: ReplyToMode;
  progress: DeliveryProgress;
}): Promise<void> {
  await sendChunkedTelegramReplyText({
    chunks: params.chunkText(params.text),
    progress: params.progress,
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
    replyMarkup: params.replyMarkup,
    markDelivered,
    sendChunk: async ({ chunk, replyToMessageId, replyMarkup }) => {
      await sendTelegramText(params.bot, params.chatId, chunk.html, params.runtime, {
        replyToMessageId,
        thread: params.thread,
        textMode: "html",
        plainText: chunk.text,
        linkPreview: params.linkPreview,
        silent: params.silent,
        replyMarkup,
      });
    },
  });
}

function isVoiceMessagesForbidden(err: unknown): boolean {
  if (err instanceof GrammyError) {
    return VOICE_FORBIDDEN_RE.test(err.description);
  }
  return VOICE_FORBIDDEN_RE.test(formatErrorMessage(err));
}

function isCaptionTooLong(err: unknown): boolean {
  if (err instanceof GrammyError) {
    return CAPTION_TOO_LONG_RE.test(err.description);
  }
  return CAPTION_TOO_LONG_RE.test(formatErrorMessage(err));
}

async function sendTelegramVoiceFallbackText(opts: {
  bot: Bot;
  chatId: string;
  runtime: RuntimeEnv;
  text: string;
  chunkText: (markdown: string) => ReturnType<typeof markdownToTelegramChunks>;
  replyToId?: number;
  thread?: TelegramThreadSpec | null;
  linkPreview?: boolean;
  silent?: boolean;
  replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  replyQuoteText?: string;
}): Promise<number | undefined> {
  let firstDeliveredMessageId: number | undefined;
  const chunks = opts.chunkText(opts.text);
  let appliedReplyTo = false;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    // Only apply reply reference, quote text, and buttons to the first chunk.
    const replyToForChunk = !appliedReplyTo ? opts.replyToId : undefined;
    const messageId = await sendTelegramText(opts.bot, opts.chatId, chunk.html, opts.runtime, {
      replyToMessageId: replyToForChunk,
      replyQuoteText: !appliedReplyTo ? opts.replyQuoteText : undefined,
      thread: opts.thread,
      textMode: "html",
      plainText: chunk.text,
      linkPreview: opts.linkPreview,
      silent: opts.silent,
      replyMarkup: !appliedReplyTo ? opts.replyMarkup : undefined,
    });
    if (firstDeliveredMessageId == null) {
      firstDeliveredMessageId = messageId;
    }
    if (replyToForChunk) {
      appliedReplyTo = true;
    }
  }
  return firstDeliveredMessageId;
}

async function deliverMediaReply(params: {
  reply: ReplyPayload;
  mediaList: string[];
  bot: Bot;
  chatId: string;
  runtime: RuntimeEnv;
  thread?: TelegramThreadSpec | null;
  tableMode?: MarkdownTableMode;
  mediaLocalRoots?: readonly string[];
  chunkText: ChunkTextFn;
  mediaLoader: typeof loadWebMedia;
  onVoiceRecording?: () => Promise<void> | void;
  linkPreview?: boolean;
  silent?: boolean;
  replyQuoteText?: string;
  replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  replyToId?: number;
  replyToMode: ReplyToMode;
  progress: DeliveryProgress;
}): Promise<number | undefined> {
  let firstDeliveredMessageId: number | undefined;
  let first = true;
  let pendingFollowUpText: string | undefined;
  for (const mediaUrl of params.mediaList) {
    const isFirstMedia = first;
    const media = await params.mediaLoader(
      mediaUrl,
      buildOutboundMediaLoadOptions({ mediaLocalRoots: params.mediaLocalRoots }),
    );
    const kind = kindFromMime(media.contentType ?? undefined);
    const isGif = isGifMedia({
      contentType: media.contentType,
      fileName: media.fileName,
    });
    const fileName = media.fileName ?? (isGif ? "animation.gif" : "file");
    const file = new InputFile(media.buffer, fileName);
    const { caption, followUpText } = splitTelegramCaption(
      isFirstMedia ? (params.reply.text ?? undefined) : undefined,
    );
    const htmlCaption = caption
      ? renderTelegramHtmlText(caption, { tableMode: params.tableMode })
      : undefined;
    if (followUpText) {
      pendingFollowUpText = followUpText;
    }
    first = false;
    const replyToMessageId = resolveReplyToForSend({
      replyToId: params.replyToId,
      replyToMode: params.replyToMode,
      progress: params.progress,
    });
    const shouldAttachButtonsToMedia = isFirstMedia && params.replyMarkup && !followUpText;
    const mediaParams: Record<string, unknown> = {
      caption: htmlCaption,
      ...(htmlCaption ? { parse_mode: "HTML" } : {}),
      ...(shouldAttachButtonsToMedia ? { reply_markup: params.replyMarkup } : {}),
      ...buildTelegramSendParams({
        replyToMessageId,
        thread: params.thread,
        silent: params.silent,
      }),
    };
    if (isGif) {
      const result = await sendTelegramWithThreadFallback({
        operation: "sendAnimation",
        runtime: params.runtime,
        thread: params.thread,
        requestParams: mediaParams,
        send: (effectiveParams) =>
          params.bot.api.sendAnimation(params.chatId, file, { ...effectiveParams }),
      });
      if (firstDeliveredMessageId == null) {
        firstDeliveredMessageId = result.message_id;
      }
      markDelivered(params.progress);
    } else if (kind === "image") {
      const result = await sendTelegramWithThreadFallback({
        operation: "sendPhoto",
        runtime: params.runtime,
        thread: params.thread,
        requestParams: mediaParams,
        send: (effectiveParams) =>
          params.bot.api.sendPhoto(params.chatId, file, { ...effectiveParams }),
      });
      if (firstDeliveredMessageId == null) {
        firstDeliveredMessageId = result.message_id;
      }
      markDelivered(params.progress);
    } else if (kind === "video") {
      const result = await sendTelegramWithThreadFallback({
        operation: "sendVideo",
        runtime: params.runtime,
        thread: params.thread,
        requestParams: mediaParams,
        send: (effectiveParams) =>
          params.bot.api.sendVideo(params.chatId, file, { ...effectiveParams }),
      });
      if (firstDeliveredMessageId == null) {
        firstDeliveredMessageId = result.message_id;
      }
      markDelivered(params.progress);
    } else if (kind === "audio") {
      const { useVoice } = resolveTelegramVoiceSend({
        wantsVoice: params.reply.audioAsVoice === true,
        contentType: media.contentType,
        fileName,
        logFallback: logVerbose,
      });
      if (useVoice) {
        const sendVoiceMedia = async (
          requestParams: typeof mediaParams,
          shouldLog?: (err: unknown) => boolean,
        ) => {
          const result = await sendTelegramWithThreadFallback({
            operation: "sendVoice",
            runtime: params.runtime,
            thread: params.thread,
            requestParams,
            shouldLog,
            send: (effectiveParams) =>
              params.bot.api.sendVoice(params.chatId, file, { ...effectiveParams }),
          });
          if (firstDeliveredMessageId == null) {
            firstDeliveredMessageId = result.message_id;
          }
          markDelivered(params.progress);
        };
        await params.onVoiceRecording?.();
        try {
          await sendVoiceMedia(mediaParams, (err) => !isVoiceMessagesForbidden(err));
        } catch (voiceErr) {
          if (isVoiceMessagesForbidden(voiceErr)) {
            const fallbackText = params.reply.text;
            if (!fallbackText || !fallbackText.trim()) {
              throw voiceErr;
            }
            logVerbose(
              "telegram sendVoice forbidden (recipient has voice messages blocked in privacy settings); falling back to text",
            );
            const voiceFallbackReplyTo = resolveReplyToForSend({
              replyToId: params.replyToId,
              replyToMode: params.replyToMode,
              progress: params.progress,
            });
            const fallbackMessageId = await sendTelegramVoiceFallbackText({
              bot: params.bot,
              chatId: params.chatId,
              runtime: params.runtime,
              text: fallbackText,
              chunkText: params.chunkText,
              replyToId: voiceFallbackReplyTo,
              thread: params.thread,
              linkPreview: params.linkPreview,
              silent: params.silent,
              replyMarkup: params.replyMarkup,
              replyQuoteText: params.replyQuoteText,
            });
            if (firstDeliveredMessageId == null) {
              firstDeliveredMessageId = fallbackMessageId;
            }
            markReplyApplied(params.progress, voiceFallbackReplyTo);
            markDelivered(params.progress);
            continue;
          }
          if (isCaptionTooLong(voiceErr)) {
            logVerbose(
              "telegram sendVoice caption too long; resending voice without caption + text separately",
            );
            const noCaptionParams = { ...mediaParams };
            delete noCaptionParams.caption;
            delete noCaptionParams.parse_mode;
            await sendVoiceMedia(noCaptionParams);
            const fallbackText = params.reply.text;
            if (fallbackText?.trim()) {
              await sendTelegramVoiceFallbackText({
                bot: params.bot,
                chatId: params.chatId,
                runtime: params.runtime,
                text: fallbackText,
                chunkText: params.chunkText,
                replyToId: undefined,
                thread: params.thread,
                linkPreview: params.linkPreview,
                silent: params.silent,
                replyMarkup: params.replyMarkup,
              });
            }
            markReplyApplied(params.progress, replyToMessageId);
            continue;
          }
          throw voiceErr;
        }
      } else {
        const result = await sendTelegramWithThreadFallback({
          operation: "sendAudio",
          runtime: params.runtime,
          thread: params.thread,
          requestParams: mediaParams,
          send: (effectiveParams) =>
            params.bot.api.sendAudio(params.chatId, file, { ...effectiveParams }),
        });
        if (firstDeliveredMessageId == null) {
          firstDeliveredMessageId = result.message_id;
        }
        markDelivered(params.progress);
      }
    } else {
      const result = await sendTelegramWithThreadFallback({
        operation: "sendDocument",
        runtime: params.runtime,
        thread: params.thread,
        requestParams: mediaParams,
        send: (effectiveParams) =>
          params.bot.api.sendDocument(params.chatId, file, { ...effectiveParams }),
      });
      if (firstDeliveredMessageId == null) {
        firstDeliveredMessageId = result.message_id;
      }
      markDelivered(params.progress);
    }
    markReplyApplied(params.progress, replyToMessageId);
    if (pendingFollowUpText && isFirstMedia) {
      await sendPendingFollowUpText({
        bot: params.bot,
        chatId: params.chatId,
        runtime: params.runtime,
        thread: params.thread,
        chunkText: params.chunkText,
        text: pendingFollowUpText,
        replyMarkup: params.replyMarkup,
        linkPreview: params.linkPreview,
        silent: params.silent,
        replyToId: params.replyToId,
        replyToMode: params.replyToMode,
        progress: params.progress,
      });
      pendingFollowUpText = undefined;
    }
  }
  return firstDeliveredMessageId;
}

async function maybePinFirstDeliveredMessage(params: {
  shouldPin: boolean;
  bot: Bot;
  chatId: string;
  runtime: RuntimeEnv;
  firstDeliveredMessageId?: number;
}): Promise<void> {
  if (!params.shouldPin || typeof params.firstDeliveredMessageId !== "number") {
    return;
  }
  try {
    await params.bot.api.pinChatMessage(params.chatId, params.firstDeliveredMessageId, {
      disable_notification: true,
    });
  } catch (err) {
    logVerbose(
      `telegram pinChatMessage failed chat=${params.chatId} message=${params.firstDeliveredMessageId}: ${formatErrorMessage(err)}`,
    );
  }
}

type EmitMessageSentHookParams = {
  sessionKeyForInternalHooks?: string;
  chatId: string;
  accountId?: string;
  content: string;
  success: boolean;
  error?: string;
  messageId?: number;
  isGroup?: boolean;
  groupId?: string;
};

function buildTelegramSentHookContext(params: EmitMessageSentHookParams) {
  return buildCanonicalSentMessageHookContext({
    to: params.chatId,
    content: params.content,
    success: params.success,
    error: params.error,
    channelId: "telegram",
    accountId: params.accountId,
    conversationId: params.chatId,
    messageId: typeof params.messageId === "number" ? String(params.messageId) : undefined,
    isGroup: params.isGroup,
    groupId: params.groupId,
  });
}

export function emitInternalMessageSentHook(params: EmitMessageSentHookParams): void {
  if (!params.sessionKeyForInternalHooks) {
    return;
  }
  const canonical = buildTelegramSentHookContext(params);
  fireAndForgetHook(
    triggerInternalHook(
      createInternalHookEvent(
        "message",
        "sent",
        params.sessionKeyForInternalHooks,
        toInternalMessageSentContext(canonical),
      ),
    ),
    "telegram: message:sent internal hook failed",
  );
}

function emitMessageSentHooks(
  params: EmitMessageSentHookParams & {
    hookRunner: ReturnType<typeof getGlobalHookRunner>;
    enabled: boolean;
  },
): void {
  if (!params.enabled && !params.sessionKeyForInternalHooks) {
    return;
  }
  const canonical = buildTelegramSentHookContext(params);
  if (params.enabled) {
    fireAndForgetHook(
      Promise.resolve(
        params.hookRunner!.runMessageSent(
          toPluginMessageSentEvent(canonical),
          toPluginMessageContext(canonical),
        ),
      ),
      "telegram: message_sent plugin hook failed",
    );
  }
  emitInternalMessageSentHook(params);
}

export async function deliverReplies(params: {
  replies: ReplyPayload[];
  chatId: string;
  accountId?: string;
  sessionKeyForInternalHooks?: string;
  mirrorIsGroup?: boolean;
  mirrorGroupId?: string;
  token: string;
  runtime: RuntimeEnv;
  bot: Bot;
  mediaLocalRoots?: readonly string[];
  replyToMode: ReplyToMode;
  textLimit: number;
  thread?: TelegramThreadSpec | null;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
  /** Callback invoked before sending a voice message to switch typing indicator. */
  onVoiceRecording?: () => Promise<void> | void;
  /** Controls whether link previews are shown. Default: true (previews enabled). */
  linkPreview?: boolean;
  /** When true, messages are sent with disable_notification. */
  silent?: boolean;
  /** Optional quote text for Telegram reply_parameters. */
  replyQuoteText?: string;
  /** Override media loader (tests). */
  mediaLoader?: typeof loadWebMedia;
}): Promise<{ delivered: boolean }> {
  const progress: DeliveryProgress = {
    hasReplied: false,
    hasDelivered: false,
    deliveredCount: 0,
  };
  const mediaLoader = params.mediaLoader ?? loadWebMedia;
  const hookRunner = getGlobalHookRunner();
  const hasMessageSendingHooks = hookRunner?.hasHooks("message_sending") ?? false;
  const hasMessageSentHooks = hookRunner?.hasHooks("message_sent") ?? false;
  const chunkText = buildChunkTextResolver({
    textLimit: params.textLimit,
    chunkMode: params.chunkMode ?? "length",
    tableMode: params.tableMode,
  });
  for (const originalReply of params.replies) {
    let reply = originalReply;
    const mediaList = reply?.mediaUrls?.length
      ? reply.mediaUrls
      : reply?.mediaUrl
        ? [reply.mediaUrl]
        : [];
    const hasMedia = mediaList.length > 0;
    if (!reply?.text && !hasMedia) {
      if (reply?.audioAsVoice) {
        logVerbose("telegram reply has audioAsVoice without media/text; skipping");
        continue;
      }
      params.runtime.error?.(danger("reply missing text/media"));
      continue;
    }

    const rawContent = reply.text || "";
    if (hasMessageSendingHooks) {
      const hookResult = await hookRunner?.runMessageSending(
        {
          to: params.chatId,
          content: rawContent,
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
      if (typeof hookResult?.content === "string" && hookResult.content !== rawContent) {
        reply = { ...reply, text: hookResult.content };
      }
    }

    const contentForSentHook = reply.text || "";

    try {
      const deliveredCountBeforeReply = progress.deliveredCount;
      const replyToId =
        params.replyToMode === "off" ? undefined : resolveTelegramReplyId(reply.replyToId);
      const telegramData = reply.channelData?.telegram as TelegramReplyChannelData | undefined;
      const shouldPinFirstMessage = telegramData?.pin === true;
      const replyMarkup = buildInlineKeyboard(telegramData?.buttons);
      let firstDeliveredMessageId: number | undefined;
      if (mediaList.length === 0) {
        firstDeliveredMessageId = await deliverTextReply({
          bot: params.bot,
          chatId: params.chatId,
          runtime: params.runtime,
          thread: params.thread,
          chunkText,
          replyText: reply.text || "",
          replyMarkup,
          replyQuoteText: params.replyQuoteText,
          linkPreview: params.linkPreview,
          silent: params.silent,
          replyToId,
          replyToMode: params.replyToMode,
          progress,
        });
      } else {
        // Try sending as a media group (album) when criteria are met.
        // A caching loader is shared between the group attempt and the
        // per-item fallback so that media downloaded during groupability
        // validation is not re-fetched on fallback.
        let usedMediaGroup = false;
        const cachedLoader = isGroupableMediaList(mediaList, reply)
          ? createCachingMediaLoader(mediaLoader)
          : mediaLoader;
        if (cachedLoader !== mediaLoader) {
          const groupResult = await deliverMediaGroupReply({
            reply,
            mediaList,
            bot: params.bot,
            chatId: params.chatId,
            runtime: params.runtime,
            thread: params.thread,
            tableMode: params.tableMode,
            mediaLocalRoots: params.mediaLocalRoots,
            chunkText,
            mediaLoader: cachedLoader,
            linkPreview: params.linkPreview,
            silent: params.silent,
            replyQuoteText: params.replyQuoteText,
            replyMarkup,
            replyToId,
            replyToMode: params.replyToMode,
            progress,
          });
          // null means the loaded media was not groupable; fall back to per-item.
          if (groupResult !== null) {
            firstDeliveredMessageId = groupResult;
            usedMediaGroup = true;
          }
        }
        if (!usedMediaGroup) {
          firstDeliveredMessageId = await deliverMediaReply({
            reply,
            mediaList,
            bot: params.bot,
            chatId: params.chatId,
            runtime: params.runtime,
            thread: params.thread,
            tableMode: params.tableMode,
            mediaLocalRoots: params.mediaLocalRoots,
            chunkText,
            mediaLoader: cachedLoader,
            onVoiceRecording: params.onVoiceRecording,
            linkPreview: params.linkPreview,
            silent: params.silent,
            replyQuoteText: params.replyQuoteText,
            replyMarkup,
            replyToId,
            replyToMode: params.replyToMode,
            progress,
          });
        }
      }
      await maybePinFirstDeliveredMessage({
        shouldPin: shouldPinFirstMessage,
        bot: params.bot,
        chatId: params.chatId,
        runtime: params.runtime,
        firstDeliveredMessageId,
      });

      emitMessageSentHooks({
        hookRunner,
        enabled: hasMessageSentHooks,
        sessionKeyForInternalHooks: params.sessionKeyForInternalHooks,
        chatId: params.chatId,
        accountId: params.accountId,
        content: contentForSentHook,
        success: progress.deliveredCount > deliveredCountBeforeReply,
        messageId: firstDeliveredMessageId,
        isGroup: params.mirrorIsGroup,
        groupId: params.mirrorGroupId,
      });
    } catch (error) {
      emitMessageSentHooks({
        hookRunner,
        enabled: hasMessageSentHooks,
        sessionKeyForInternalHooks: params.sessionKeyForInternalHooks,
        chatId: params.chatId,
        accountId: params.accountId,
        content: contentForSentHook,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        isGroup: params.mirrorIsGroup,
        groupId: params.mirrorGroupId,
      });
      throw error;
    }
  }

  return { delivered: progress.hasDelivered };
}

import type { Message } from "@grammyjs/types";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { danger, logVerbose, warn } from "openclaw/plugin-sdk/runtime-env";
import {
  hasInboundMedia,
  isRecoverableMediaGroupError,
  resolveInboundMediaFileId,
} from "./bot-handlers.media.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import { MEDIA_GROUP_TIMEOUT_MS, type MediaGroupEntry } from "./bot-updates.js";
import { resolveMedia } from "./bot/delivery.js";
import type { TelegramContext, TelegramSyntheticContextSource } from "./bot/types.js";
import type { TelegramTransport } from "./fetch.js";

export type TelegramDebounceLane = "default" | "forward";

export type TelegramDebounceEntry = {
  ctx: TelegramContext;
  msg: Message;
  allMedia: TelegramMediaRef[];
  storeAllowFrom: string[];
  debounceKey: string | null;
  debounceLane: TelegramDebounceLane;
  botUsername?: string;
};

export type TextFragmentEntry = {
  key: string;
  messages: Array<{ msg: Message; ctx: TelegramContext; receivedAtMs: number }>;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_TEXT_FRAGMENT_MAX_GAP_MS = 1500;

type TelegramBotApi = {
  sendMessage: (
    chatId: number | string,
    text: string,
    params?: { message_thread_id?: number },
  ) => Promise<unknown>;
  getFile: (fileId: string) => Promise<{ file_path?: string }>;
};

export function createTelegramInboundBufferRuntime(params: {
  accountId?: string | null;
  bot: { api: TelegramBotApi };
  cfg: OpenClawConfig;
  logger: { warn: (...args: unknown[]) => void };
  mediaMaxBytes: number;
  opts: {
    token: string;
    testTimings?: {
      textFragmentGapMs?: number;
      mediaGroupFlushMs?: number;
    };
  };
  processMessage: (
    ctx: TelegramContext,
    media: TelegramMediaRef[],
    storeAllowFrom: string[],
    metadata?: { messageIdOverride?: string },
    replyMedia?: TelegramMediaRef[],
  ) => Promise<void>;
  loadStoreAllowFrom: () => Promise<string[]>;
  runtime: {
    error?: (message: string) => void;
  };
  telegramTransport?: TelegramTransport;
}) {
  const {
    accountId,
    bot,
    cfg,
    logger,
    mediaMaxBytes,
    opts,
    processMessage,
    loadStoreAllowFrom,
    runtime,
    telegramTransport,
  } = params;
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
      : MEDIA_GROUP_TIMEOUT_MS;
  const debounceMs = resolveInboundDebounceMs({ cfg, channel: "telegram" });
  const FORWARD_BURST_DEBOUNCE_MS = 80;

  const mediaGroupBuffer = new Map<string, MediaGroupEntry>();
  let mediaGroupProcessing: Promise<void> = Promise.resolve();
  const textFragmentBuffer = new Map<string, TextFragmentEntry>();
  let textFragmentProcessing: Promise<void> = Promise.resolve();

  const resolveTelegramDebounceLane = (msg: Message): TelegramDebounceLane => {
    return msg.forward_origin ? "forward" : "default";
  };

  const buildSyntheticTextMessage = (params: {
    base: Message;
    text: string;
    date?: number;
    from?: Message["from"];
  }): Message => ({
    ...params.base,
    ...(params.from ? { from: params.from } : {}),
    text: params.text,
    caption: undefined,
    caption_entities: undefined,
    entities: undefined,
    ...(params.date != null ? { date: params.date } : {}),
  });

  const buildSyntheticContext = (
    ctx: TelegramSyntheticContextSource,
    message: Message,
  ): TelegramContext => {
    const getFile =
      typeof ctx.getFile === "function" ? ctx.getFile.bind(ctx as object) : async () => ({});
    return { message, me: ctx.me, getFile };
  };

  const resolveReplyMediaForMessage = async (
    ctx: TelegramContext,
    msg: Message,
  ): Promise<TelegramMediaRef[]> => {
    const replyMessage = msg.reply_to_message;
    if (!replyMessage || !hasInboundMedia(replyMessage)) {
      return [];
    }
    const replyFileId = resolveInboundMediaFileId(replyMessage);
    if (!replyFileId) {
      return [];
    }
    try {
      const media = await resolveMedia(
        {
          message: replyMessage,
          me: ctx.me,
          getFile: async () => await bot.api.getFile(replyFileId),
        },
        mediaMaxBytes,
        opts.token,
        telegramTransport,
      );
      if (!media) {
        return [];
      }
      return [
        {
          path: media.path,
          contentType: media.contentType,
          stickerMetadata: media.stickerMetadata,
        },
      ];
    } catch (err) {
      logger.warn({ chatId: msg.chat.id, error: String(err) }, "reply media fetch failed");
      return [];
    }
  };

  const processMediaGroup = async (entry: MediaGroupEntry) => {
    try {
      entry.messages.sort(
        (a: { msg: Message; ctx: TelegramContext }, b: { msg: Message; ctx: TelegramContext }) =>
          a.msg.message_id - b.msg.message_id,
      );
      const captionMsg = entry.messages.find((item) => item.msg.caption || item.msg.text);
      const primaryEntry = captionMsg ?? entry.messages[0];

      const allMedia: TelegramMediaRef[] = [];
      for (const { ctx } of entry.messages) {
        let media;
        try {
          media = await resolveMedia(ctx, mediaMaxBytes, opts.token, telegramTransport);
        } catch (mediaErr) {
          if (!isRecoverableMediaGroupError(mediaErr)) {
            throw mediaErr;
          }
          runtime.error?.(
            warn(`media group: skipping photo that failed to fetch: ${String(mediaErr)}`),
          );
          continue;
        }
        if (media) {
          allMedia.push({
            path: media.path,
            contentType: media.contentType,
            stickerMetadata: media.stickerMetadata,
          });
        }
      }

      const storeAllowFrom = await loadStoreAllowFrom();
      const replyMedia = await resolveReplyMediaForMessage(primaryEntry.ctx, primaryEntry.msg);
      await processMessage(primaryEntry.ctx, allMedia, storeAllowFrom, undefined, replyMedia);
    } catch (err) {
      runtime.error?.(danger(`media group handler failed: ${String(err)}`));
    }
  };

  const flushTextFragments = async (entry: TextFragmentEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);
      const first = entry.messages[0];
      const last = entry.messages.at(-1);
      if (!first || !last) {
        return;
      }
      const combinedText = entry.messages.map((item) => item.msg.text ?? "").join("");
      if (!combinedText.trim()) {
        return;
      }
      const syntheticMessage = buildSyntheticTextMessage({
        base: first.msg,
        text: combinedText,
        date: last.msg.date ?? first.msg.date,
      });
      const storeAllowFrom = await loadStoreAllowFrom();
      await processMessage(buildSyntheticContext(first.ctx, syntheticMessage), [], storeAllowFrom, {
        messageIdOverride: String(last.msg.message_id),
      });
    } catch (err) {
      runtime.error?.(danger(`text fragment handler failed: ${String(err)}`));
    }
  };

  const queueTextFragmentFlush = async (entry: TextFragmentEntry) => {
    textFragmentProcessing = textFragmentProcessing
      .then(async () => {
        await flushTextFragments(entry);
      })
      .catch(() => undefined);
    await textFragmentProcessing;
  };

  const runTextFragmentFlush = async (entry: TextFragmentEntry) => {
    textFragmentBuffer.delete(entry.key);
    await queueTextFragmentFlush(entry);
  };

  const scheduleTextFragmentFlush = (entry: TextFragmentEntry) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      await runTextFragmentFlush(entry);
    }, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS);
  };

  const inboundDebouncer = createInboundDebouncer<TelegramDebounceEntry>({
    debounceMs,
    resolveDebounceMs: (entry) =>
      entry.debounceLane === "forward" ? FORWARD_BURST_DEBOUNCE_MS : debounceMs,
    buildKey: (entry) => entry.debounceKey,
    shouldDebounce: (entry) => {
      const text = entry.msg.text ?? entry.msg.caption ?? "";
      const hasDebounceableText = shouldDebounceTextInbound({
        text,
        cfg,
        commandOptions: { botUsername: entry.botUsername },
      });
      if (entry.debounceLane === "forward") {
        return hasDebounceableText || entry.allMedia.length > 0;
      }
      return hasDebounceableText && entry.allMedia.length === 0;
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        const replyMedia = await resolveReplyMediaForMessage(last.ctx, last.msg);
        await processMessage(last.ctx, last.allMedia, last.storeAllowFrom, undefined, replyMedia);
        return;
      }
      const combinedText = entries
        .map((entry) => entry.msg.text ?? entry.msg.caption ?? "")
        .filter(Boolean)
        .join("\n");
      const combinedMedia = entries.flatMap((entry) => entry.allMedia);
      if (!combinedText.trim() && combinedMedia.length === 0) {
        return;
      }
      const first = entries[0];
      const syntheticMessage = buildSyntheticTextMessage({
        base: first.msg,
        text: combinedText,
        date: last.msg.date ?? first.msg.date,
      });
      const messageIdOverride = last.msg.message_id ? String(last.msg.message_id) : undefined;
      const replyMedia = await resolveReplyMediaForMessage(first.ctx, syntheticMessage);
      await processMessage(
        buildSyntheticContext(first.ctx, syntheticMessage),
        combinedMedia,
        first.storeAllowFrom,
        messageIdOverride ? { messageIdOverride } : undefined,
        replyMedia,
      );
    },
    onError: (err, items) => {
      runtime.error?.(danger(`telegram debounce flush failed: ${String(err)}`));
      const chatId = items[0]?.msg.chat.id;
      if (chatId != null) {
        const threadId = items[0]?.msg.message_thread_id;
        void bot.api
          .sendMessage(
            chatId,
            "Something went wrong while processing your message. Please try again.",
            threadId != null ? { message_thread_id: threadId } : undefined,
          )
          .catch((sendErr) => {
            logVerbose(`telegram: error fallback send failed: ${String(sendErr)}`);
          });
      }
    },
  });

  return {
    buildSyntheticContext,
    buildSyntheticTextMessage,
    inboundDebouncer,
    mediaGroupBuffer,
    mediaGroupProcessing: () => mediaGroupProcessing,
    setMediaGroupProcessing: (next: Promise<void>) => {
      mediaGroupProcessing = next;
    },
    mediaGroupTimeoutMs,
    processMediaGroup,
    textFragmentBuffer,
    textFragmentProcessing: () => textFragmentProcessing,
    setTextFragmentProcessing: (next: Promise<void>) => {
      textFragmentProcessing = next;
    },
    scheduleTextFragmentFlush,
    flushTextFragments,
    resolveReplyMediaForMessage,
    resolveTelegramDebounceLane,
    TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS,
    TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP,
    TELEGRAM_TEXT_FRAGMENT_MAX_PARTS,
    TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS,
    TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS,
  };
}

// Telegram plugin module implements draft stream behavior.
import type { Bot } from "grammy";
import {
  createFinalizableDraftStreamControlsForState,
  takeMessageIdAfterStop,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";
import { renderTelegramHtmlText, telegramHtmlToPlainTextFallback } from "./format.js";
import {
  isRecoverableTelegramNetworkError,
  isSafeToRetrySendError,
  isTelegramClientRejection,
  isTelegramMessageNotModifiedError,
  isTelegramRateLimitError,
  readTelegramRetryAfterMs,
} from "./network-errors.js";
import { TELEGRAM_TEXT_CHUNK_LIMIT } from "./outbound-adapter.js";
import { normalizeTelegramReplyToMessageId } from "./outbound-params.js";
import {
  buildTelegramRichMarkdown,
  getTelegramRichRawApi,
  isTelegramRichMessageWithinStructuralLimits,
  TELEGRAM_RICH_TEXT_LIMIT,
  type TelegramInputRichMessage,
  type TelegramSendRichMessageParams,
} from "./rich-message.js";

const TELEGRAM_STREAM_MAX_CHARS = TELEGRAM_TEXT_CHUNK_LIMIT;
const DEFAULT_THROTTLE_MS = 1000;
const TELEGRAM_PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;
// Retryable preview failures keep the latest text pending for the next throttle
// tick; cap consecutive misses so a persistent outage stops the preview instead
// of warn-spamming for the rest of the run.
const MAX_CONSECUTIVE_PREVIEW_FAILURES = 3;
// Flood waits beyond this freeze the preview longer than it is useful; clamp so
// a large retry_after cannot park the suspension past the run's lifetime.
const MAX_PREVIEW_FLOOD_SUSPEND_MS = 60_000;

export type TelegramDraftStream = {
  update: (text: string) => void;
  updatePreview: (preview: TelegramDraftPreview) => void;
  flush: () => Promise<void>;
  messageId: () => number | undefined;
  visibleSinceMs?: () => number | undefined;
  previewRevision?: () => number;
  lastDeliveredText?: () => string;
  clear: () => Promise<void>;
  stop: () => Promise<void>;
  /** Stop without a final flush or delete. */
  discard?: () => Promise<void>;
  /** Return the current preview message id after pending updates settle. */
  materialize?: () => Promise<number | undefined>;
  /** Reset internal state so the next update creates a new message instead of editing. */
  forceNewMessage: () => void;
  /** True when a preview sendMessage was attempted but the response was lost. */
  sendMayHaveLanded?: () => boolean;
};

export type TelegramDraftPreview = {
  text: string;
  parseMode?: "HTML";
  richMessage?: TelegramInputRichMessage;
};

type SupersededTelegramPreview = {
  messageId: number;
  textSnapshot: string;
  visibleSinceMs?: number;
  retain?: boolean;
};

type TelegramDraftTransportPreview = {
  plainText: string;
  text: string;
  parseMode?: "HTML";
};

function renderTelegramDraftPreview(
  text: string,
  renderText: ((text: string) => TelegramDraftPreview) | undefined,
): TelegramDraftPreview {
  const trimmed = text.trimEnd();
  return renderText?.(trimmed) ?? { text: trimmed };
}

function isTelegramHtmlParseError(err: unknown): boolean {
  return TELEGRAM_PARSE_ERR_RE.test(formatErrorMessage(err));
}

function normalizeTelegramDraftTransportPreview(
  preview: TelegramDraftPreview,
): TelegramDraftTransportPreview {
  if (preview.richMessage?.html) {
    return {
      text: preview.richMessage.html,
      parseMode: "HTML",
      plainText: preview.text,
    };
  }
  if (preview.richMessage?.markdown) {
    return {
      text: renderTelegramHtmlText(preview.richMessage.markdown),
      parseMode: "HTML",
      plainText: preview.text,
    };
  }
  if (preview.parseMode === "HTML") {
    return {
      text: preview.text,
      parseMode: "HTML",
      plainText: telegramHtmlToPlainTextFallback(preview.text),
    };
  }
  return {
    text: preview.text,
    plainText: preview.text,
  };
}

function telegramDraftPreviewKey(preview: TelegramDraftPreview): string {
  return JSON.stringify({
    text: preview.text,
    parseMode: preview.parseMode ?? "plain",
    richMessage: preview.richMessage,
  });
}

function telegramDraftRichPayloadLength(preview: TelegramDraftPreview): number {
  const sourceMessage = preview.richMessage ?? { markdown: preview.text };
  if (!isTelegramRichMessageWithinStructuralLimits(sourceMessage)) {
    return TELEGRAM_RICH_TEXT_LIMIT + 1;
  }
  const richMessage = preview.richMessage ?? buildTelegramRichMarkdown(preview.text);
  return richMessage.html?.length ?? richMessage.markdown?.length ?? 0;
}

function resolveTelegramDraftRenderedText(
  preview: TelegramDraftPreview,
  richMessages: boolean,
): string {
  return richMessages ? preview.text : normalizeTelegramDraftTransportPreview(preview).text;
}

function findTelegramDraftChunkLength(
  text: string,
  maxChars: number,
  renderText: ((text: string) => TelegramDraftPreview) | undefined,
  richMessages: boolean,
): number {
  let best = 0;
  let low = 1;
  let high = text.length;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const preview = renderTelegramDraftPreview(text.slice(0, mid), renderText);
    const renderedText = resolveTelegramDraftRenderedText(preview, richMessages).trimEnd();
    const payloadLength = richMessages
      ? telegramDraftRichPayloadLength(preview)
      : renderedText.length;
    if (renderedText && payloadLength <= maxChars) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

export function createTelegramDraftStream(params: {
  api: Bot["api"];
  chatId: Parameters<Bot["api"]["sendMessage"]>[0];
  maxChars?: number;
  thread?: TelegramThreadSpec | null;
  replyToMessageId?: number;
  richMessages?: boolean;
  throttleMs?: number;
  /** Minimum chars before sending first message (debounce for push notifications) */
  minInitialChars?: number;
  /** Maximum time to hold a short first preview before materializing it anyway. */
  minInitialDelayMs?: number;
  /** Optional preview renderer (e.g. markdown -> HTML + parse mode). */
  renderText?: (text: string) => TelegramDraftPreview;
  /** Called when a late send resolves after forceNewMessage() switched generations. */
  onSupersededPreview?: (preview: SupersededTelegramPreview) => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): TelegramDraftStream {
  const richMessages = params.richMessages === true;
  const transportLimit = richMessages ? TELEGRAM_RICH_TEXT_LIMIT : TELEGRAM_STREAM_MAX_CHARS;
  const maxChars = Math.min(params.maxChars ?? transportLimit, transportLimit);
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const minInitialChars = params.minInitialChars;
  const minInitialDelayMs = params.minInitialDelayMs;
  const chatId = params.chatId;
  const threadParams = buildTelegramThreadParams(params.thread);
  const replyToMessageId = normalizeTelegramReplyToMessageId(params.replyToMessageId);
  const sendMessageParams =
    replyToMessageId != null
      ? {
          ...threadParams,
          reply_parameters: {
            message_id: replyToMessageId,
            allow_sending_without_reply: true,
          },
        }
      : (threadParams ?? {});
  const richMessageParams: Omit<TelegramSendRichMessageParams, "chat_id" | "rich_message"> =
    replyToMessageId != null
      ? {
          ...threadParams,
          reply_parameters: {
            message_id: replyToMessageId,
            allow_sending_without_reply: true,
          },
        }
      : (threadParams ?? {});

  const streamState = { stopped: false, final: false };
  let messageSendAttempted = false;
  let suspendedUntilMs = 0;
  let consecutivePreviewFailures = 0;
  let streamMessageId: number | undefined;
  let streamVisibleSinceMs: number | undefined;
  let lastSentPreviewKey = "";
  let lastDeliveredText = "";
  let lastRequestedText = "";
  let lastRequestedPreview: TelegramDraftPreview | undefined;
  let firstShortPreviewSeenMs: number | undefined;
  let initialPreviewTimer: ReturnType<typeof setTimeout> | undefined;
  let previewRevision = 0;
  let generation = 0;
  let deliveredTextOffset = 0;
  type PreviewSendParams = {
    preview: TelegramDraftPreview;
    sendGeneration: number;
  };
  const sendRenderedMessage = async (preview: TelegramDraftPreview) => {
    if (richMessages) {
      return await getTelegramRichRawApi(params.api).sendRichMessage({
        chat_id: chatId,
        rich_message: preview.richMessage ?? buildTelegramRichMarkdown(preview.text),
        ...richMessageParams,
      });
    }
    const transportPreview = normalizeTelegramDraftTransportPreview(preview);
    const sendPlain = async () =>
      await params.api.sendMessage(chatId, transportPreview.plainText, sendMessageParams);
    if (transportPreview.parseMode !== "HTML") {
      return await sendPlain();
    }
    try {
      return await params.api.sendMessage(chatId, transportPreview.text, {
        parse_mode: "HTML" as const,
        ...sendMessageParams,
      });
    } catch (err) {
      if (!isTelegramHtmlParseError(err)) {
        throw err;
      }
      return await sendPlain();
    }
  };
  const sendMessageTransportPreview = async ({
    preview,
    sendGeneration,
  }: PreviewSendParams): Promise<boolean> => {
    if (typeof streamMessageId === "number") {
      streamVisibleSinceMs ??= Date.now();
      if (richMessages) {
        await getTelegramRichRawApi(params.api).editMessageText({
          chat_id: chatId,
          message_id: streamMessageId,
          rich_message: preview.richMessage ?? buildTelegramRichMarkdown(preview.text),
        });
        return true;
      }
      const transportPreview = normalizeTelegramDraftTransportPreview(preview);
      if (transportPreview.parseMode === "HTML") {
        try {
          await params.api.editMessageText(chatId, streamMessageId, transportPreview.text, {
            parse_mode: "HTML" as const,
          });
        } catch (err) {
          if (!isTelegramHtmlParseError(err)) {
            throw err;
          }
          await params.api.editMessageText(chatId, streamMessageId, transportPreview.plainText);
        }
      } else {
        await params.api.editMessageText(chatId, streamMessageId, transportPreview.text);
      }
      return true;
    }
    messageSendAttempted = true;
    let sent: Awaited<ReturnType<typeof sendRenderedMessage>>;
    try {
      sent = await sendRenderedMessage(preview);
    } catch (err) {
      if (isSafeToRetrySendError(err) || isTelegramClientRejection(err)) {
        messageSendAttempted = false;
      }
      throw err;
    }
    const sentMessageId = sent?.message_id;
    if (typeof sentMessageId !== "number" || !Number.isFinite(sentMessageId)) {
      streamState.stopped = true;
      params.warn?.("telegram stream preview stopped (missing message id from sendMessage)");
      return false;
    }
    const normalizedMessageId = Math.trunc(sentMessageId);
    const visibleSinceMs = Date.now();
    if (sendGeneration !== generation) {
      params.onSupersededPreview?.({
        messageId: normalizedMessageId,
        textSnapshot: preview.text,
        visibleSinceMs,
        retain: true,
      });
      return true;
    }
    streamMessageId = normalizedMessageId;
    streamVisibleSinceMs = visibleSinceMs;
    return true;
  };
  const clearInitialPreviewTimer = () => {
    if (initialPreviewTimer) {
      clearTimeout(initialPreviewTimer);
      initialPreviewTimer = undefined;
    }
  };
  const scheduleInitialPreviewFlush = (delayMs: number) => {
    if (initialPreviewTimer || !flushInitialPreview) {
      return;
    }
    initialPreviewTimer = setTimeout(
      () => {
        initialPreviewTimer = undefined;
        void flushInitialPreview?.().catch((err: unknown) => {
          params.warn?.(`telegram stream preview delayed send failed: ${formatErrorMessage(err)}`);
        });
      },
      Math.max(0, delayMs),
    );
  };
  const stopOversizedPreview = (payloadLength: number): false => {
    streamState.stopped = true;
    params.warn?.(`telegram stream preview stopped (text length ${payloadLength} > ${maxChars})`);
    return false;
  };

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    if (streamState.stopped && !streamState.final) {
      return false;
    }
    // Flood-control suspension: returning false keeps the newest text pending,
    // so the first tick after retry_after delivers it. Final flushes still try
    // so the last text has a chance to land.
    if (!streamState.final && Date.now() < suspendedUntilMs) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return false;
    }
    const currentText = trimmed.slice(deliveredTextOffset).trimStart();
    if (!currentText) {
      return false;
    }
    const rendered =
      deliveredTextOffset === 0 && lastRequestedPreview?.text === trimmed
        ? lastRequestedPreview
        : renderTelegramDraftPreview(currentText, params.renderText);
    const renderedText = resolveTelegramDraftRenderedText(rendered, richMessages).trimEnd();
    const renderedPayloadLength = richMessages
      ? telegramDraftRichPayloadLength(rendered)
      : renderedText.length;
    const renderedPreview = { ...rendered, text: renderedText };
    const renderedPreviewKey = telegramDraftPreviewKey(renderedPreview);
    if (!renderedText) {
      return false;
    }
    if (renderedPayloadLength > maxChars) {
      const chunkLength = findTelegramDraftChunkLength(
        currentText,
        maxChars,
        params.renderText,
        richMessages,
      );
      if (!streamState.final) {
        if (chunkLength > 0) {
          return await sendOrEditStreamMessage(
            trimmed.slice(0, deliveredTextOffset) + currentText.slice(0, chunkLength),
          );
        }
        return stopOversizedPreview(renderedPayloadLength);
      }
      if (lastDeliveredText.length > deliveredTextOffset) {
        const supersededMessageId = streamMessageId;
        const supersededTextSnapshot = lastDeliveredText.slice(deliveredTextOffset);
        const supersededVisibleSinceMs = streamVisibleSinceMs;
        deliveredTextOffset = lastDeliveredText.length;
        resetStreamToNewMessage({ keepFinal: true, keepPending: true, resetOffset: false });
        if (typeof supersededMessageId === "number") {
          params.onSupersededPreview?.({
            messageId: supersededMessageId,
            textSnapshot: supersededTextSnapshot,
            visibleSinceMs: supersededVisibleSinceMs,
            retain: true,
          });
        }
        return await sendOrEditStreamMessage(trimmed);
      }
      if (chunkLength > 0) {
        const sent = await sendOrEditStreamMessage(
          trimmed.slice(0, deliveredTextOffset) + currentText.slice(0, chunkLength),
        );
        if (!sent) {
          return false;
        }
        return await sendOrEditStreamMessage(trimmed);
      }
      return stopOversizedPreview(renderedPayloadLength);
    }
    if (renderedPreviewKey === lastSentPreviewKey) {
      return true;
    }
    const sendGeneration = generation;

    if (typeof streamMessageId !== "number" && minInitialChars != null && !streamState.final) {
      if (renderedText.length < minInitialChars) {
        if (minInitialDelayMs == null) {
          return false;
        }
        const now = Date.now();
        firstShortPreviewSeenMs ??= now;
        const remainingDelayMs = minInitialDelayMs - (now - firstShortPreviewSeenMs);
        if (remainingDelayMs > 0) {
          scheduleInitialPreviewFlush(remainingDelayMs);
          return false;
        }
        clearInitialPreviewTimer();
      } else {
        firstShortPreviewSeenMs = undefined;
        clearInitialPreviewTimer();
      }
    } else {
      firstShortPreviewSeenMs = undefined;
      clearInitialPreviewTimer();
    }

    const previousSentPreviewKey = lastSentPreviewKey;
    lastSentPreviewKey = renderedPreviewKey;
    try {
      const sent = await sendMessageTransportPreview({
        preview: renderedPreview,
        sendGeneration,
      });
      if (sent) {
        previewRevision += 1;
        lastDeliveredText = trimmed;
        consecutivePreviewFailures = 0;
        suspendedUntilMs = 0;
      }
      return sent;
    } catch (err) {
      const isEdit = typeof streamMessageId === "number";
      if (isEdit && isTelegramMessageNotModifiedError(err)) {
        // Telegram already shows exactly this text; count the edit as delivered.
        consecutivePreviewFailures = 0;
        lastDeliveredText = trimmed;
        return true;
      }
      // Roll back the dedupe snapshot so the retried tick is not skipped as a no-op.
      lastSentPreviewKey = previousSentPreviewKey;
      // Flood control is always retryable: Telegram rejected the call outright.
      // Beyond that, edits retry on any transient network error (re-editing the
      // same content is idempotent) while an unsent first preview retries only
      // on provably pre-connect failures — anything ambiguous could duplicate
      // the preview message.
      const retryable =
        isTelegramRateLimitError(err) ||
        (isEdit ? isRecoverableTelegramNetworkError(err) : isSafeToRetrySendError(err));
      consecutivePreviewFailures += 1;
      if (retryable && consecutivePreviewFailures <= MAX_CONSECUTIVE_PREVIEW_FAILURES) {
        const retryAfterMs = readTelegramRetryAfterMs(err);
        if (retryAfterMs !== undefined) {
          suspendedUntilMs = Date.now() + Math.min(retryAfterMs, MAX_PREVIEW_FLOOD_SUSPEND_MS);
        }
        params.warn?.(
          `telegram stream preview ${isEdit ? "edit" : "send"} failed (retrying): ${formatErrorMessage(err)}`,
        );
        return false;
      }
      streamState.stopped = true;
      params.warn?.(`telegram stream preview failed: ${formatErrorMessage(err)}`);
      return false;
    }
  };

  const {
    loop,
    update: updateDraft,
    stopForClear,
  } = createFinalizableDraftStreamControlsForState({
    throttleMs,
    state: streamState,
    sendOrEditStreamMessage,
  });
  const flushInitialPreview = loop.flush;

  const requestDraftUpdate = (text: string, preview?: TelegramDraftPreview) => {
    if (streamState.stopped || streamState.final) {
      return;
    }
    lastRequestedPreview = preview;
    lastRequestedText = text;
    updateDraft(text);
  };

  const update = (text: string) => {
    requestDraftUpdate(text);
  };

  const updatePreview = (preview: TelegramDraftPreview) => {
    const text = preview.text.trimEnd();
    if (!text) {
      return;
    }
    requestDraftUpdate(text, { ...preview, text });
  };

  const stop = async () => {
    streamState.final = true;
    await loop.flush();
    if (streamState.stopped) {
      return;
    }
    const finalText = lastRequestedText.trimEnd();
    if (finalText && finalText !== lastDeliveredText.trimEnd()) {
      await sendOrEditStreamMessage(finalText);
    }
    streamState.final = true;
  };

  const resetStreamToNewMessage: (options?: {
    keepFinal?: boolean;
    keepPending?: boolean;
    resetOffset?: boolean;
  }) => void = (options) => {
    streamState.stopped = false;
    streamState.final = options?.keepFinal === true;
    generation += 1;
    messageSendAttempted = false;
    streamMessageId = undefined;
    streamVisibleSinceMs = undefined;
    firstShortPreviewSeenMs = undefined;
    clearInitialPreviewTimer();
    lastSentPreviewKey = "";
    if (options?.resetOffset !== false) {
      deliveredTextOffset = 0;
      lastRequestedText = "";
    }
    if (!options?.keepPending) {
      loop.resetPending();
      lastRequestedPreview = undefined;
    }
    loop.resetThrottleWindow();
  };

  const clear = async () => {
    clearInitialPreviewTimer();
    const messageId = await takeMessageIdAfterStop({
      stopForClear,
      readMessageId: () => streamMessageId,
      clearMessageId: () => {
        streamMessageId = undefined;
      },
    });
    if (typeof messageId === "number" && Number.isFinite(messageId)) {
      try {
        await params.api.deleteMessage(chatId, messageId);
        params.log?.(`telegram stream preview deleted (chat=${chatId}, message=${messageId})`);
      } catch (err) {
        params.warn?.(`telegram stream preview cleanup failed: ${formatErrorMessage(err)}`);
      }
    }
  };

  const discard = async () => {
    clearInitialPreviewTimer();
    await stopForClear();
  };

  const forceNewMessage = () => {
    resetStreamToNewMessage();
  };

  const materialize = async (): Promise<number | undefined> => {
    await stop();
    return streamMessageId;
  };

  params.log?.(`telegram stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update,
    updatePreview,
    flush: loop.flush,
    messageId: () => streamMessageId,
    visibleSinceMs: () => streamVisibleSinceMs,
    previewRevision: () => previewRevision,
    lastDeliveredText: () => lastDeliveredText,
    clear,
    stop,
    discard,
    materialize,
    forceNewMessage,
    sendMayHaveLanded: () => messageSendAttempted && typeof streamMessageId !== "number",
  };
}

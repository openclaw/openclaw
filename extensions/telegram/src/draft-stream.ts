import type { Bot } from "grammy";
import {
  createFinalizableDraftStreamControlsForState,
  takeMessageIdAfterStop,
} from "openclaw/plugin-sdk/channel-lifecycle";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";
import {
  getTelegramRetryAfterMs,
  isSafeToRetrySendError,
  isTelegramClientRejection,
  isTelegramRateLimitError,
} from "./network-errors.js";
import { normalizeTelegramReplyToMessageId } from "./outbound-params.js";

const TELEGRAM_STREAM_MAX_CHARS = 4096;
const DEFAULT_THROTTLE_MS = 1000;
const THREAD_NOT_FOUND_RE = /400:\s*Bad Request:\s*message thread not found/i;

type TelegramSendMessageParams = Parameters<Bot["api"]["sendMessage"]>[2];

function hasNumericMessageThreadId(
  params: TelegramSendMessageParams | undefined,
): params is TelegramSendMessageParams & { message_thread_id: number } {
  return (
    typeof params === "object" &&
    params !== null &&
    typeof (params as { message_thread_id?: unknown }).message_thread_id === "number"
  );
}

export type TelegramDraftStream = {
  update: (text: string) => void;
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

type TelegramDraftPreview = {
  text: string;
  parseMode?: "HTML";
};

type SupersededTelegramPreview = {
  messageId: number;
  textSnapshot: string;
  parseMode?: "HTML";
  visibleSinceMs?: number;
  /**
   * When true the message should be retained in the chat rather than
   * scheduled for deletion.  Set on overflow-chain splits where the
   * superseded chunk is the first page of a multi-page stream.
   */
  retain?: boolean;
};

function findRawFitLength(
  rawSlice: string,
  maxChars: number,
  renderFn: ((text: string) => TelegramDraftPreview) | undefined,
): number {
  let lo = 0;
  let hi = rawSlice.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const chunk = rawSlice.slice(0, mid);
    const chunkRendered = renderFn?.(chunk) ?? { text: chunk };
    if (chunkRendered.text.trimEnd().length <= maxChars) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

export function createTelegramDraftStream(params: {
  api: Bot["api"];
  chatId: Parameters<Bot["api"]["sendMessage"]>[0];
  maxChars?: number;
  thread?: TelegramThreadSpec | null;
  replyToMessageId?: number;
  throttleMs?: number;
  /** Minimum chars before sending first message (debounce for push notifications) */
  minInitialChars?: number;
  /** Optional preview renderer (e.g. markdown -> HTML + parse mode). */
  renderText?: (text: string) => TelegramDraftPreview;
  /** Renderer used for overflow continuation messages (textBaseOffset > 0). Falls back to renderText. */
  renderContinuationText?: (text: string) => TelegramDraftPreview;
  /** Called when a late send resolves after forceNewMessage() switched generations. */
  onSupersededPreview?: (preview: SupersededTelegramPreview) => void;
  /**
   * Optional shared rate limiter across lanes. acquire() resolves when it is safe to send,
   * enforcing a minimum inter-send interval across all streams sharing the bucket.
   */
  rateLimiter?: { acquire(): Promise<void> };
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): TelegramDraftStream {
  const maxChars = Math.min(
    params.maxChars ?? TELEGRAM_STREAM_MAX_CHARS,
    TELEGRAM_STREAM_MAX_CHARS,
  );
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const minInitialChars = params.minInitialChars;
  const chatId = params.chatId;
  let textBaseOffset = 0;
  const threadParams = buildTelegramThreadParams(params.thread);
  const replyToMessageId = normalizeTelegramReplyToMessageId(params.replyToMessageId);
  const replyParams =
    replyToMessageId != null
      ? {
          ...threadParams,
          reply_to_message_id: replyToMessageId,
          allow_sending_without_reply: true,
        }
      : threadParams;

  const streamState = { stopped: false, final: false };
  let messageSendAttempted = false;
  let streamMessageId: number | undefined;
  let streamVisibleSinceMs: number | undefined;
  let lastSentText = "";
  let lastDeliveredText = "";
  let lastSentParseMode: "HTML" | undefined;
  let previewRevision = 0;
  let generation = 0;
  let rateLimitedUntilMs = 0;
  let pendingForceNewMessage = false;
  type PreviewSendParams = {
    renderedText: string;
    renderedParseMode: "HTML" | undefined;
    sendGeneration: number;
  };
  const sendRenderedMessageWithThreadFallback = async (sendArgs: {
    renderedText: string;
    renderedParseMode: "HTML" | undefined;
    fallbackWarnMessage: string;
  }) => {
    const sendParams = sendArgs.renderedParseMode
      ? {
          ...replyParams,
          parse_mode: sendArgs.renderedParseMode,
        }
      : replyParams;
    const usedThreadParams = hasNumericMessageThreadId(sendParams);
    try {
      return {
        sent: await params.api.sendMessage(chatId, sendArgs.renderedText, sendParams),
        usedThreadParams,
      };
    } catch (err) {
      if (!usedThreadParams || !THREAD_NOT_FOUND_RE.test(String(err))) {
        throw err;
      }
      const threadlessParams: TelegramSendMessageParams = { ...sendParams };
      delete threadlessParams.message_thread_id;
      params.warn?.(sendArgs.fallbackWarnMessage);
      return {
        sent: await params.api.sendMessage(
          chatId,
          sendArgs.renderedText,
          Object.keys(threadlessParams).length > 0 ? threadlessParams : undefined,
        ),
        usedThreadParams: false,
      };
    }
  };
  const sendMessageTransportPreview = async ({
    renderedText,
    renderedParseMode,
    sendGeneration,
  }: PreviewSendParams): Promise<boolean> => {
    if (typeof streamMessageId === "number") {
      streamVisibleSinceMs ??= Date.now();
      if (renderedParseMode) {
        await params.api.editMessageText(chatId, streamMessageId, renderedText, {
          parse_mode: renderedParseMode,
        });
      } else {
        await params.api.editMessageText(chatId, streamMessageId, renderedText);
      }
      return true;
    }
    messageSendAttempted = true;
    let sent: Awaited<ReturnType<typeof sendRenderedMessageWithThreadFallback>>["sent"];
    try {
      ({ sent } = await sendRenderedMessageWithThreadFallback({
        renderedText,
        renderedParseMode,
        fallbackWarnMessage:
          "telegram stream preview send failed with message_thread_id, retrying without thread",
      }));
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
        textSnapshot: renderedText,
        parseMode: renderedParseMode,
        visibleSinceMs,
      });
      return true;
    }
    streamMessageId = normalizedMessageId;
    streamVisibleSinceMs = visibleSinceMs;
    return true;
  };

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    if (streamState.stopped && !streamState.final) {
      return false;
    }
    // Wait out any active 429 backoff at the entry point so newer pending text
    // (accumulated while the failing send was in-flight) is used for the retry
    // rather than the stale text the loop snapshotted before the failed send.
    if (rateLimitedUntilMs > 0) {
      const remaining = rateLimitedUntilMs - Date.now();
      if (remaining > 0) {
        await new Promise<void>((r) => setTimeout(r, remaining));
      }
      rateLimitedUntilMs = 0;
      if (pendingForceNewMessage) {
        pendingForceNewMessage = false;
        textBaseOffset = 0;
        resetStreamToNewMessage();
      }
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return false;
    }
    const sliced = textBaseOffset > 0 ? trimmed.slice(textBaseOffset).trimStart() : trimmed;
    if (!sliced) {
      return false;
    }
    const renderFn =
      textBaseOffset > 0 && params.renderContinuationText
        ? params.renderContinuationText
        : params.renderText;
    const rendered = renderFn?.(sliced) ?? { text: sliced };
    const renderedText = rendered.text.trimEnd();
    const renderedParseMode = rendered.parseMode;
    if (!renderedText) {
      return false;
    }
    if (renderedText.length > maxChars) {
      // When the rendered slice overflows, chain to a new message.
      const deliveredRaw = lastDeliveredText.length;
      const deliveredLen =
        deliveredRaw > textBaseOffset ? deliveredRaw - textBaseOffset : lastSentText.length;
      if (deliveredLen > 0) {
        // Already-delivered content provides the natural split point.
        const supersededMessageId = streamMessageId;
        const supersededTextSnapshot = lastDeliveredText;
        textBaseOffset += deliveredLen;
        resetStreamToNewMessage();
        lastDeliveredText = "";
        streamState.stopped = false;
        if (typeof supersededMessageId === "number") {
          params.onSupersededPreview?.({
            messageId: supersededMessageId,
            textSnapshot: supersededTextSnapshot,
            retain: true,
          });
        }
        params.log?.(
          `telegram stream preview overflow (${renderedText.length} > ${maxChars}); chaining to new message (offset=${textBaseOffset})`,
        );
        const overflowSlice = trimmed.slice(textBaseOffset).trimStart();
        if (overflowSlice) {
          return await sendOrEditStreamMessage(text);
        }
        return true;
      }
      // Nothing delivered yet: binary-search for the largest fitting prefix and send it,
      // then chain the remainder so the stream keeps draining.
      const fitLen = findRawFitLength(sliced, maxChars, renderFn);
      if (fitLen === 0) {
        streamState.stopped = true;
        params.warn?.(
          `telegram stream preview stopped (text length ${renderedText.length} > ${maxChars})`,
        );
        return false;
      }
      params.log?.(
        `telegram stream preview overflow (${renderedText.length} > ${maxChars}); splitting at raw offset ${textBaseOffset + fitLen}`,
      );
      const fitText = trimmed.slice(0, textBaseOffset + fitLen);
      const sent = await sendOrEditStreamMessage(fitText);
      if (!sent) {
        return false;
      }
      streamState.stopped = false;
      return await sendOrEditStreamMessage(text);
    }
    if (renderedText === lastSentText && renderedParseMode === lastSentParseMode) {
      return true;
    }
    const sendGeneration = generation;

    if (typeof streamMessageId !== "number" && minInitialChars != null && !streamState.final) {
      if (renderedText.length < minInitialChars) {
        return false;
      }
    }

    lastSentText = renderedText;
    lastSentParseMode = renderedParseMode;
    await params.rateLimiter?.acquire();
    try {
      const sent = await sendMessageTransportPreview({
        renderedText,
        renderedParseMode,
        sendGeneration,
      });
      if (sent) {
        previewRevision += 1;
        lastDeliveredText = trimmed;
      }
      return sent;
    } catch (err) {
      if (isTelegramRateLimitError(err)) {
        const retryAfterMs = getTelegramRetryAfterMs(err) ?? 5_000;
        const backoffMs = retryAfterMs + 500;
        rateLimitedUntilMs = Date.now() + backoffMs;
        // Clear sent-state markers so the retry does not hit the duplicate-text early-exit.
        lastSentText = "";
        lastSentParseMode = undefined;
        params.warn?.(
          `telegram stream preview rate limited; backing off ${retryAfterMs}ms (retry_after from API)`,
        );
        // Return false immediately without sleeping. The backoff wait is deferred to
        // the start of the next sendOrEditStreamMessage call so any pending text
        // accumulated during the in-flight send is preserved rather than overwritten
        // by the draft loop's sent===false restore path.
        return false;
      }
      streamState.stopped = true;
      params.warn?.(`telegram stream preview failed: ${formatErrorMessage(err)}`);
      return false;
    }
  };

  const { loop, update, stop, stopForClear } = createFinalizableDraftStreamControlsForState({
    throttleMs,
    state: streamState,
    sendOrEditStreamMessage,
  });

  const clear = async () => {
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
      return;
    }
  };

  const discard = async () => {
    await stopForClear();
  };

  const resetStreamToNewMessage = () => {
    streamState.stopped = false;
    streamState.final = false;
    generation += 1;
    messageSendAttempted = false;
    streamMessageId = undefined;
    streamVisibleSinceMs = undefined;
    lastSentText = "";
    lastSentParseMode = undefined;
    loop.resetPending();
    loop.resetThrottleWindow();
  };

  const forceNewMessage = () => {
    if (rateLimitedUntilMs > 0 && Date.now() < rateLimitedUntilMs) {
      const remainingMs = rateLimitedUntilMs - Date.now();
      params.warn?.(
        `telegram stream preview: forceNewMessage suppressed during 429 backoff (${remainingMs}ms remaining); lane rotation deferred`,
      );
      pendingForceNewMessage = true;
      return;
    }
    textBaseOffset = 0;
    resetStreamToNewMessage();
  };

  const materialize = async (): Promise<number | undefined> => {
    await stop();
    return streamMessageId;
  };

  params.log?.(`telegram stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update,
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

export const __testing = {
  resetTelegramDraftStreamForTests: () => {},
};

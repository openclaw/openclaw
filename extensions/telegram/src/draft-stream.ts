import type { Bot } from "grammy";
import {
  createFinalizableDraftStreamControlsForState,
  takeMessageIdAfterStop,
} from "openclaw/plugin-sdk/channel-lifecycle";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";
import {
  getTelegramRetryAfterMs,
  isRecoverableTelegramNetworkError,
  isSafeToRetrySendError,
  isTelegramClientRejection,
  isTelegramRateLimitError,
} from "./network-errors.js";
import { normalizeTelegramReplyToMessageId } from "./outbound-params.js";

const TELEGRAM_STREAM_MAX_CHARS = 4096;
const DEFAULT_THROTTLE_MS = 1000;
const THREAD_NOT_FOUND_RE = /400:\s*Bad Request:\s*message thread not found/i;

const CHAT_SEND_INTERVAL_MS = 3_000;

type AdaptiveThrottleState = {
  currentMs: number;
  minMs: number;
  maxMs: number;
  pausedUntil: number;
  decayInterval: ReturnType<typeof setInterval> | null;
};

const _adaptiveThrottleState = ((globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.adaptiveThrottle")
] ??= {
  currentMs: DEFAULT_THROTTLE_MS,
  minMs: DEFAULT_THROTTLE_MS,
  maxMs: 120_000,
  pausedUntil: 0,
  decayInterval: null,
} satisfies AdaptiveThrottleState) as AdaptiveThrottleState;

export function getAdaptiveThrottleMs(): number {
  const pauseRemaining = _adaptiveThrottleState.pausedUntil - Date.now();
  if (pauseRemaining > 0) {
    return Math.max(_adaptiveThrottleState.currentMs, pauseRemaining);
  }
  return _adaptiveThrottleState.currentMs;
}

function onTelegramRateLimit(retryAfterSec: number): void {
  const retryMs = (retryAfterSec || 30) * 1000;
  _adaptiveThrottleState.currentMs = Math.min(
    Math.max(retryMs, _adaptiveThrottleState.currentMs),
    _adaptiveThrottleState.maxMs,
  );
  _adaptiveThrottleState.pausedUntil = Date.now() + retryMs;
  if (!_adaptiveThrottleState.decayInterval) {
    _adaptiveThrottleState.decayInterval = setInterval(() => {
      if (Date.now() < _adaptiveThrottleState.pausedUntil) {
        return;
      }
      _adaptiveThrottleState.currentMs = Math.max(
        _adaptiveThrottleState.currentMs * 0.5,
        _adaptiveThrottleState.minMs,
      );
      if (_adaptiveThrottleState.currentMs <= _adaptiveThrottleState.minMs) {
        clearInterval(_adaptiveThrottleState.decayInterval!);
        _adaptiveThrottleState.decayInterval = null;
      }
    }, 10_000);
    _adaptiveThrottleState.decayInterval.unref?.();
  }
}

type ChatSendGateEntry = { lastSentAt: number; queue: number[] };
const _perChatSendGate = ((globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.perChatSendGate")
] ??= new Map<string | number, ChatSendGateEntry>()) as Map<string | number, ChatSendGateEntry>;

let _gateStreamIdCounter =
  ((globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.gateStreamIdCounter")
  ] as number) ?? 0;

function acquireChatSendGate(
  chatId: string | number,
  streamId: number,
  intervalMs: number,
  isFinal: boolean,
): boolean {
  if (intervalMs <= 0) {
    return true;
  }
  let gate = _perChatSendGate.get(chatId);
  if (!gate) {
    gate = { lastSentAt: 0, queue: [] };
    _perChatSendGate.set(chatId, gate);
  }
  const now = Date.now();
  const elapsed = now - gate.lastSentAt;
  if (isFinal) {
    const idx = gate.queue.indexOf(streamId);
    if (idx !== -1) {
      gate.queue.splice(idx, 1);
    }
    if (elapsed < intervalMs) {
      return false;
    }
    gate.lastSentAt = now;
    return true;
  }
  if (elapsed < intervalMs) {
    if (!gate.queue.includes(streamId)) {
      gate.queue.push(streamId);
    }
    return false;
  }
  if (gate.queue.length > 0) {
    if (gate.queue[0] !== streamId) {
      if (!gate.queue.includes(streamId)) {
        gate.queue.push(streamId);
      }
      return false;
    }
    gate.queue.shift();
  }
  gate.lastSentAt = now;
  return true;
}

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
  /** Skip the minInitialChars debounce (e.g. for reasoning lanes that should start immediately). */
  skipMinInitialChars?: boolean;
  /** Pre-send gate callback. Return false to suppress this send cycle (e.g. wait for another lane). */
  beforeGate?: () => boolean;
  /** Optional preview renderer (e.g. markdown -> HTML + parse mode). */
  renderText?: (text: string) => TelegramDraftPreview;
  /** Renderer used for overflow continuation messages (textBaseOffset > 0). Falls back to renderText. */
  renderContinuationText?: (text: string) => TelegramDraftPreview;
  /** Called when a late send resolves after forceNewMessage() switched generations. */
  onSupersededPreview?: (preview: SupersededTelegramPreview) => void;
  /** Minimum ms between sends to the same chat. 0 disables. Default: 3000. */
  chatSendIntervalMs?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): TelegramDraftStream {
  const maxChars = Math.min(
    params.maxChars ?? TELEGRAM_STREAM_MAX_CHARS,
    TELEGRAM_STREAM_MAX_CHARS,
  );
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const chatSendIntervalMs = params.chatSendIntervalMs ?? CHAT_SEND_INTERVAL_MS;
  const minInitialChars = params.skipMinInitialChars ? undefined : params.minInitialChars;
  const beforeGate = params.beforeGate;
  const chatId = params.chatId;
  const streamId = ++_gateStreamIdCounter;
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.gateStreamIdCounter")] =
    _gateStreamIdCounter;
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
  let backoffRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let deferredFlush: (() => void) | undefined;
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
    // Non-blocking 429 check: return false immediately while rate-limited so
    // the draft loop can coalesce update() calls and retry with the latest text
    // once the backoff expires. No await — backpressure stays in the loop, not
    // the transport.
    if (rateLimitedUntilMs > 0) {
      const remaining = rateLimitedUntilMs - Date.now();
      if (remaining > 0) {
        return false;
      }
      rateLimitedUntilMs = 0;
      if (pendingForceNewMessage) {
        pendingForceNewMessage = false;
        textBaseOffset = 0;
        resetStreamToNewMessage();
      }
    }
    if (beforeGate && !beforeGate()) {
      return false;
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

    if (!acquireChatSendGate(chatId, streamId, chatSendIntervalMs, streamState.final)) {
      return false;
    }

    lastSentText = renderedText;
    lastSentParseMode = renderedParseMode;
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
        const retryAfterSec = Math.ceil(retryAfterMs / 1000);
        const backoffMs = retryAfterMs + 500;
        rateLimitedUntilMs = Date.now() + backoffMs;
        lastSentText = "";
        lastSentParseMode = undefined;
        onTelegramRateLimit(retryAfterSec);
        params.warn?.(
          `telegram stream preview rate limited; backing off ${retryAfterMs}ms (retry_after from API)`,
        );
        if (backoffRetryTimer) {
          clearTimeout(backoffRetryTimer);
        }
        backoffRetryTimer = setTimeout(() => {
          backoffRetryTimer = undefined;
          deferredFlush?.();
        }, backoffMs);
        return false;
      }
      if (typeof streamMessageId === "number") {
        if (isRecoverableTelegramNetworkError(err, { allowMessageMatch: true })) {
          lastSentText = "";
          lastSentParseMode = undefined;
          params.warn?.(
            `telegram stream preview transient network error (will retry): ${formatErrorMessage(err)}`,
          );
          return false;
        }
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
  deferredFlush = () => void loop.flush();

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
    if (backoffRetryTimer) {
      clearTimeout(backoffRetryTimer);
      backoffRetryTimer = undefined;
    }
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
  resetTelegramDraftStreamForTests: () => {
    _perChatSendGate.clear();
    _adaptiveThrottleState.currentMs = DEFAULT_THROTTLE_MS;
    _adaptiveThrottleState.pausedUntil = 0;
    if (_adaptiveThrottleState.decayInterval) {
      clearInterval(_adaptiveThrottleState.decayInterval);
      _adaptiveThrottleState.decayInterval = null;
    }
  },
  clearPerChatSendGate: () => {
    _perChatSendGate.clear();
  },
};

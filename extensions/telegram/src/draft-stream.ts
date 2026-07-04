// Telegram plugin module implements draft stream behavior.
import type { Bot } from "grammy";
import {
  createFinalizableDraftStreamControlsForState,
  takeMessageIdAfterStop,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
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
// Minimum time the streaming preview ("gerund" box) stays on screen before it
// is deleted at teardown, measured from when it first became visible. On fast
// turns the box otherwise flashed and vanished before it could be read, and the
// immediate delete could race a just-persisted message (intermittently dropping
// the first verbose commentary). The delete is scheduled DETACHED so the turn is
// never stalled waiting on the dwell.
const MIN_PREVIEW_DWELL_MS = 4_000;

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
  /**
   * Collapse the preview in place: edit the existing window message so its
   * content becomes `preview`, then stop without deleting. Used at end-of-turn
   * so the streaming window becomes the summary bar (no delete + repost, which
   * scroll-jumps the client). Returns the message id if the edit landed.
   */
  finalizeToPreview: (preview: TelegramDraftPreview) => Promise<number | undefined>;
  /** Reset internal state so the next update creates a new message instead of editing. */
  forceNewMessage: () => void;
  /**
   * Reposition the window: rewind so the next update creates a new message,
   * and schedule the superseded message's delete for AFTER the new one lands
   * (post-new-then-delete-old, never delete-then-repost — avoids the client
   * scroll-jump). Returns the superseded message id, if any.
   */
  rotateToNewMessageDeferringDelete: () => number | undefined;
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

function telegramRichHtmlToParseModeHtml(html: string): string {
  return html.replace(/<br\s*\/?>/giu, "\n");
}

function normalizeTelegramDraftTransportPreview(
  preview: TelegramDraftPreview,
): TelegramDraftTransportPreview {
  if (preview.richMessage?.html) {
    return {
      text: telegramRichHtmlToParseModeHtml(preview.richMessage.html),
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
      // Bot API parse_mode=HTML has no <br>; line breaks must be literal
      // newlines. Sending <br> verbatim 400s every multi-line preview edit,
      // dropping the whole progress draft to the unformatted plain fallback.
      text: telegramRichHtmlToParseModeHtml(preview.text),
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
  return sliceUtf16Safe(text, 0, best).length;
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
  let previewRevision = 0;
  let generation = 0;
  let deliveredTextOffset = 0;
  // Generations whose in-flight FIRST send was superseded by a reposition
  // (rotateToNewMessageDeferringDelete). Their late-landing message is a stale
  // ephemeral preview to delete, NOT a durable content chunk to retain — that
  // distinguishes a reposition from forceNewMessage's continuation-chunk race.
  const repositionedSendGenerations = new Set<number>();
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
      if (repositionedSendGenerations.delete(sendGeneration)) {
        // A reposition rotated past this send while it was in flight: the landed
        // message is a stale preview, so delete it deferred (same as the
        // reposition's own old message) instead of leaking an orphaned bubble.
        scheduleDetachedDelete(normalizedMessageId, visibleSinceMs, REPOSITION_DELETE_DELAY_MS);
        return true;
      }
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
    const renderedPreviewKey = telegramDraftPreviewKey({ ...rendered, text: renderedText });
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
        return false;
      }
    }

    const previousSentPreviewKey = lastSentPreviewKey;
    lastSentPreviewKey = renderedPreviewKey;
    try {
      const sent = await sendMessageTransportPreview({
        preview: rendered,
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

  // Delete a superseded preview message DETACHED (scheduled, never awaited) so
  // teardown is never stalled. The delay is at least the remaining on-screen
  // dwell (so a preview is never flashed), and at least `minDelayMs` — a
  // reposition passes a small floor so the NEW message has landed below before
  // the old one disappears, keeping the viewport anchored instead of jumping.
  const scheduleDetachedDelete = (
    messageId: number,
    visibleSince: number | undefined,
    minDelayMs = 0,
  ) => {
    const runDelete = async () => {
      try {
        await params.api.deleteMessage(chatId, messageId);
        params.log?.(`telegram stream preview deleted (chat=${chatId}, message=${messageId})`);
      } catch (err) {
        params.warn?.(`telegram stream preview cleanup failed: ${formatErrorMessage(err)}`);
      }
    };
    const elapsedMs =
      typeof visibleSince === "number" ? Date.now() - visibleSince : MIN_PREVIEW_DWELL_MS;
    const remainingDwellMs = Math.max(0, MIN_PREVIEW_DWELL_MS - elapsedMs);
    const delayMs = Math.max(remainingDwellMs, minDelayMs);
    if (delayMs <= 0) {
      void runDelete();
    } else {
      setTimeout(() => {
        void runDelete();
      }, delayMs);
    }
  };

  const clear = async () => {
    // Capture before the stop; takeMessageIdAfterStop resets streamVisibleSinceMs.
    const visibleSince = streamVisibleSinceMs;
    const messageId = await takeMessageIdAfterStop({
      stopForClear,
      readMessageId: () => streamMessageId,
      clearMessageId: () => {
        streamMessageId = undefined;
      },
    });
    if (typeof messageId === "number" && Number.isFinite(messageId)) {
      // Keep the preview on screen for at least MIN_PREVIEW_DWELL_MS from when it
      // first appeared, then delete.
      scheduleDetachedDelete(messageId, visibleSince);
    }
  };

  // Reposition the window: rewind so the NEXT update creates a fresh message
  // (below anything posted since), then delete the superseded one AFTER a short
  // delay so the new message lands first. Post-new-then-delete-old — never
  // delete-then-repost, which scroll-jumps the Telegram client (the on-off
  // durable-🧠 jump). Returns the superseded message id (for tests).
  const REPOSITION_DELETE_DELAY_MS = 1_500;
  const rotateToNewMessageDeferringDelete = (): number | undefined => {
    const supersededMessageId = streamMessageId;
    const supersededVisibleSince = streamVisibleSinceMs;
    // A FIRST send may still be in flight (no id yet): mark its generation so the
    // late-landing message is deleted as a reposition, not retained as a durable
    // chunk (forceNewMessage's contract). resetStreamToNewMessage bumps
    // generation, so capture the current one before rewinding.
    if (messageSendAttempted && streamMessageId === undefined) {
      repositionedSendGenerations.add(generation);
    }
    // Rewind WITHOUT deleting; the old id is captured above.
    resetStreamToNewMessage();
    if (typeof supersededMessageId === "number" && Number.isFinite(supersededMessageId)) {
      scheduleDetachedDelete(supersededMessageId, supersededVisibleSince, REPOSITION_DELETE_DELAY_MS);
      return supersededMessageId;
    }
    return undefined;
  };

  const discard = async () => {
    await stopForClear();
  };

  const forceNewMessage = () => {
    resetStreamToNewMessage();
  };

  const materialize = async (): Promise<number | undefined> => {
    await stop();
    return streamMessageId;
  };

  const finalizeToPreview = async (
    preview: TelegramDraftPreview,
  ): Promise<number | undefined> => {
    const text = preview.text.trimEnd();
    if (!text) {
      return undefined;
    }
    // Settle pending updates so we edit the real, current window message.
    streamState.final = true;
    await loop.flush();
    // A throttled preview can still be pending (the last tool-progress line was
    // coalesced and never sent), leaving no message id even though the window
    // "rendered". Materialize it as a final flush would, so the window message
    // exists and can be edited in place — otherwise on-off collapses missed it
    // and fell back to a delete + repost.
    if (typeof streamMessageId !== "number" && !streamState.stopped) {
      const pending = lastRequestedText.trimEnd();
      if (pending && pending !== lastDeliveredText.trimEnd()) {
        await sendOrEditStreamMessage(pending);
      }
    }
    // Genuinely no live window message (rv mode never rendered): caller posts a
    // fresh durable bar instead — but it must NOT delete anything.
    if (typeof streamMessageId !== "number") {
      return undefined;
    }
    // Replace the whole message with the bar line: edits diff from a zero
    // offset, not from the streamed prefix.
    deliveredTextOffset = 0;
    lastSentPreviewKey = "";
    lastRequestedText = text;
    lastRequestedPreview = { ...preview, text };
    // The edit can fail to apply (flood-wait 429 or a terminal error both return
    // false). Report that as "not collapsed in place" so the caller falls back to
    // posting a durable bar instead of assuming the tall window became the bar.
    const edited = await sendOrEditStreamMessage(text);
    if (!edited) {
      return undefined;
    }
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
    finalizeToPreview,
    forceNewMessage,
    rotateToNewMessageDeferringDelete,
    sendMayHaveLanded: () => messageSendAttempted && typeof streamMessageId !== "number",
  };
}

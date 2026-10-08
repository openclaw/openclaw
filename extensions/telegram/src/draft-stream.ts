import type { Bot } from "grammy";
import type { Message } from "grammy/types";
import {
  createFinalizableDraftStreamControlsForState,
  takeMessageIdAfterStop,
} from "openclaw/plugin-sdk/channel-outbound";
import type { ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import {
  runAuthorizedTelegramRequest,
  runReplaceableTelegramRequest,
} from "./account-throttler.js";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";
import type { TelegramNativeQuoteCandidate } from "./bot/native-quote.js";
import {
  sendTelegramDraftMessage,
  editTelegramDraftMessage,
  toDraftSnapshot,
  type TelegramDraftMessageSnapshot,
  type TelegramDraftPreview,
} from "./draft-stream-message.js";
import { escapeTelegramHtml, telegramHtmlToPlainTextFallback } from "./format.js";
import {
  TelegramRequestNotStartedError,
  isRetryableTelegramApiError,
  isSafeToRetrySendError,
  isTelegramClientRejection,
  isTelegramMessageNotModifiedError,
  isTelegramRateLimitError,
} from "./network-errors.js";
import { TELEGRAM_TEXT_CHUNK_LIMIT } from "./outbound-adapter.js";
import { normalizeTelegramReplyToMessageId } from "./outbound-params.js";
import { buildTelegramThreadReplyParams } from "./reply-parameters.js";
import { TELEGRAM_RICH_TEXT_LIMIT } from "./rich-message.js";
import {
  planTelegramTextDeliveryPages,
  type TelegramTextDeliveryPage,
} from "./telegram-text-delivery.js";

const DEFAULT_THROTTLE_MS = 1000;
// Retryable preview failures keep the latest text pending for the next throttle
// tick; cap consecutive misses so a persistent outage stops the preview instead
// of warn-spamming for the rest of the run.
const MAX_CONSECUTIVE_PREVIEW_FAILURES = 3;
// Minimum time the streaming preview ("gerund" box) stays on screen before it
// is deleted at teardown, measured from when it first became visible. On fast
// turns the box otherwise flashed and vanished before it could be read, and the
// immediate delete could race a just-persisted message (intermittently dropping
// the first verbose commentary). The delete is scheduled DETACHED so the turn is
// never stalled waiting on the dwell.
const MIN_PREVIEW_DWELL_MS = 4_000;

export type TelegramDraftStream = ReturnType<typeof createTelegramDraftStream>;

type TelegramDraftUpdate = string | { resolveText: () => string | undefined };

type RetainedTelegramDraftPage = {
  messageId: number;
  textSnapshot: string;
  visibleSinceMs?: number;
};

type SingleUseReplyTargetState =
  | { kind: "available" }
  | { kind: "pending"; generation: number }
  | { kind: "retained"; generation: number; messageId: number };

export function createTelegramDraftStream(params: {
  api: Bot["api"];
  chatId: Parameters<Bot["api"]["sendMessage"]>[0];
  maxChars?: number;
  thread?: TelegramThreadSpec | null;
  replyToMessageId?: number;
  replyToMode?: ReplyToMode;
  replyQuote?: TelegramNativeQuoteCandidate;
  richMessages?: boolean;
  throttleMs?: number;
  /**
   * When false, suppress Telegram link previews on the streamed draft. Rich
   * messages express this as `skip_entity_detection` at render time instead.
   */
  linkPreview?: boolean;
  /** Minimum chars before sending first message (debounce for push notifications) */
  minInitialChars?: number;
  /** Optional preview renderer (e.g. markdown -> HTML + parse mode). */
  renderText?: (text: string) => TelegramDraftPreview;
  /** Called when a completed page remains visible after the stream advances. */
  onRetainedPage?: (page: RetainedTelegramDraftPage) => void;
  /** Validates Telegram's response before another preview message can be sent. */
  validateProviderMessage?: (message: Message) => Promise<void> | void;
  /** Called with Telegram's response after a new preview message becomes durable. */
  onProviderMessage?: (message: Message) => Promise<void> | void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}) {
  const richMessages = params.richMessages === true;
  const transportLimit = richMessages ? TELEGRAM_RICH_TEXT_LIMIT : TELEGRAM_TEXT_CHUNK_LIMIT;
  const maxChars = Math.min(params.maxChars ?? transportLimit, transportLimit);
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const minInitialChars = params.minInitialChars;
  const chatId = params.chatId;
  const threadParams = buildTelegramThreadParams(params.thread);
  const replyToMessageId = normalizeTelegramReplyToMessageId(params.replyToMessageId);
  const quoteParams = params.replyQuote
    ? buildTelegramThreadReplyParams({
        replyToMessageId,
        replyQuoteMessageId: replyToMessageId,
        replyQuoteText: params.replyQuote.text,
        replyQuotePosition: params.replyQuote.position,
        replyQuoteEntities: params.replyQuote.entities,
      }).reply_parameters
    : undefined;
  const initialSendMessageParams =
    replyToMessageId != null
      ? {
          ...threadParams,
          reply_parameters: {
            message_id: replyToMessageId,
            allow_sending_without_reply: true,
            ...quoteParams,
          },
        }
      : (threadParams ?? {});
  const consumesReplyTarget =
    replyToMessageId != null &&
    params.replyToMode !== undefined &&
    isSingleUseReplyToMode(params.replyToMode);
  // A single-use reply belongs to the concrete message that remains visible.
  // Repositioning keeps pending/retained ownership until Telegram confirms the
  // superseded message was deleted; otherwise two visible messages can reply.
  let replyTargetState: SingleUseReplyTargetState = { kind: "available" };
  const reserveReplyTargetForSend = (sendGeneration: number) => {
    if (!consumesReplyTarget) {
      return initialSendMessageParams;
    }
    if (replyTargetState.kind !== "available") {
      return threadParams ?? {};
    }
    replyTargetState = { kind: "pending", generation: sendGeneration };
    return initialSendMessageParams;
  };
  const settlePendingReplyTarget = (sendGeneration: number, messageId?: number) => {
    if (replyTargetState.kind === "pending" && replyTargetState.generation === sendGeneration) {
      replyTargetState =
        messageId === undefined
          ? { kind: "available" }
          : { kind: "retained", generation: sendGeneration, messageId };
    }
  };
  const streamState = { stopped: false, final: false };
  let messageSendAttempted = false;
  let consecutivePreviewFailures = 0;
  let streamMessageId: number | undefined;
  let streamMessageSnapshot: TelegramDraftMessageSnapshot | undefined;
  let streamProviderMessage: Message | undefined;
  let terminalDeliveryError: Error | undefined;
  const pendingProviderObservations = new Set<Promise<void>>();
  let streamVisibleSinceMs: number | undefined;
  let lastSentPreviewKey = "";
  let lastDeliveredText = "";
  let lastRequestedText = "";
  let lastRequestedPreview: TelegramDraftPreview | undefined;
  let pendingPlatformSendDispatch: (() => Promise<void>) | undefined;
  let pendingPlatformSendAuthorization: (() => void) | undefined;
  // Counts requested updates: callers may reuse one assertion, so an earlier
  // attempt must not settle the authority a newer update still needs.
  let requestedUpdates = 0;
  let generation = 0;
  let finalPagePlan: { pages: TelegramTextDeliveryPage[]; nextPageIndex: number } | undefined;
  // Generations whose in-flight FIRST send was superseded by a reposition
  // (rotateToNewMessageDeferringDelete). Their late-landing message is a stale
  // ephemeral preview to delete, NOT a durable content chunk to retain — that
  // distinguishes a reposition from forceNewMessage's continuation-chunk race.
  const repositionedSendGenerations = new Set<number>();
  // Repositioned previews stay visible until a replacement message is accepted;
  // deleting them on a timer alone can leave the chat with no reply at all.
  let supersededPreviews: Array<{ messageId: number; visibleSinceMs?: number }> = [];
  // Unfinished previews are superseded by the next update: under flood pressure the
  // account limiter skips them so final replies keep Telegram's budget. Only the
  // Bot API calls are marked; cleanup and observation keep normal priority.
  // Previews and final sends carry authority through scheduler and flood waits
  // so the limiter rechecks the current writer before each network attempt.
  const previewRequest = <T>(
    assertCurrent: (() => void) | undefined,
    run: () => Promise<T>,
  ): Promise<T> =>
    runAuthorizedTelegramRequest(assertCurrent, () =>
      streamState.final ? run() : runReplaceableTelegramRequest(run),
    );
  const scheduleProviderMessageObservation = (message: Message | undefined) => {
    if (!message) {
      return;
    }
    const observation = (async () => {
      try {
        await params.onProviderMessage?.(message);
      } catch (err) {
        // Observation follows an accepted Telegram send. Never turn a cache
        // failure into a transport retry that could duplicate the message.
        try {
          params.warn?.(`telegram stream preview observation failed: ${formatErrorMessage(err)}`);
        } catch {
          // Diagnostics must not make the observation task reject.
        }
      }
    })();
    pendingProviderObservations.add(observation);
    void observation.then(() => {
      pendingProviderObservations.delete(observation);
    });
  };
  const observeCurrentProviderMessage = () => {
    const message = streamProviderMessage;
    streamProviderMessage = undefined;
    scheduleProviderMessageObservation(message);
  };
  const drainProviderMessageObservations = async () => {
    await Promise.all(pendingProviderObservations);
  };
  const sendMessageTransportPreview = async (
    page: TelegramTextDeliveryPage,
    sendGeneration: number,
    disableLinkPreview: boolean,
  ): Promise<boolean> => {
    const linkPreviewParams = disableLinkPreview
      ? ({ link_preview_options: { is_disabled: true } } as const)
      : {};
    if (pendingPlatformSendDispatch) {
      await pendingPlatformSendDispatch();
      pendingPlatformSendDispatch = undefined;
    }
    // Authority belongs to the pending update, not to one attempt: a skipped or
    // failed attempt keeps it, so every retry rechecks it until the update lands
    // or a newer one replaces it.
    const assertPlatformSendAuthorized = pendingPlatformSendAuthorization;
    assertPlatformSendAuthorized?.();
    const targetMessageId = streamMessageId;
    if (typeof targetMessageId === "number") {
      const acceptedSnapshot = await editTelegramDraftMessage({
        api: params.api,
        chatId,
        messageId: targetMessageId,
        page,
        linkPreviewParams,
        warn: params.warn,
        request: (send) => previewRequest(assertPlatformSendAuthorized, send),
      });
      if (sendGeneration === generation && streamMessageId === targetMessageId) {
        streamMessageSnapshot = acceptedSnapshot;
      }
      return true;
    }
    messageSendAttempted = true;
    const sendMessageParams = reserveReplyTargetForSend(sendGeneration);
    let sent: Awaited<ReturnType<typeof sendTelegramDraftMessage>>;
    try {
      sent = await previewRequest(assertPlatformSendAuthorized, () =>
        sendTelegramDraftMessage({
          api: params.api,
          chatId,
          page,
          sendMessageParams,
          linkPreviewParams,
          warn: params.warn,
          assertCurrentSend: () => {
            if (sendGeneration !== generation || streamState.stopped) {
              throw new TelegramRequestNotStartedError("Telegram preview generation retired");
            }
            assertPlatformSendAuthorized?.();
          },
        }),
      );
    } catch (err) {
      const definitelyRejected = isSafeToRetrySendError(err) || isTelegramClientRejection(err);
      if (sendGeneration === generation && definitelyRejected) {
        messageSendAttempted = false;
      }
      if (definitelyRejected) {
        settlePendingReplyTarget(sendGeneration);
      }
      throw err;
    }
    const sentMessageId = sent.message?.message_id;
    const normalizedMessageId =
      typeof sentMessageId === "number" && Number.isFinite(sentMessageId)
        ? Math.trunc(sentMessageId)
        : undefined;
    if (normalizedMessageId === undefined) {
      if (sendGeneration === generation) {
        streamState.stopped = true;
        params.warn?.("telegram stream preview stopped (missing message id from sendMessage)");
        return false;
      }
      return true;
    }
    settlePendingReplyTarget(sendGeneration, normalizedMessageId);
    const adoptSentMessage = () => {
      streamMessageId = normalizedMessageId;
      streamMessageSnapshot = sent.snapshot;
      streamProviderMessage = sent.message;
      streamVisibleSinceMs = Date.now();
    };
    try {
      if (params.validateProviderMessage) {
        await params.validateProviderMessage(sent.message);
      }
    } catch (error) {
      terminalDeliveryError ??=
        error instanceof Error ? error : new Error(formatErrorMessage(error));
      streamState.stopped = true;
      if (sendGeneration === generation) {
        adoptSentMessage();
      } else if (repositionedSendGenerations.delete(sendGeneration)) {
        retireWhenReplaced(normalizedMessageId, Date.now());
      }
      return false;
    }
    if (sendGeneration !== generation) {
      const visibleSinceMs = Date.now();
      if (repositionedSendGenerations.delete(sendGeneration)) {
        // Repositioned late sends are stale previews; delete instead of retaining
        // them as durable continuation pages.
        retireWhenReplaced(normalizedMessageId, visibleSinceMs);
        return true;
      }
      params.onRetainedPage?.({
        messageId: normalizedMessageId,
        textSnapshot: sent.snapshot.text,
        visibleSinceMs,
      });
      scheduleProviderMessageObservation(sent.message);
      return true;
    }
    adoptSentMessage();
    retireSupersededPreviews();
    return true;
  };
  const sendOrEditPlannedPage = async (
    page: TelegramTextDeliveryPage,
    complete = false,
    disableLinkPreview = params.linkPreview === false,
  ): Promise<boolean> => {
    const renderedPreviewKey = JSON.stringify([
      page.sourceTextMode,
      page.sourceText,
      page.richMessage?.skip_entity_detection === true,
      disableLinkPreview,
    ]);
    if (renderedPreviewKey === lastSentPreviewKey) {
      return true;
    }
    const sendGeneration = generation;

    if (
      typeof streamMessageId !== "number" &&
      minInitialChars != null &&
      !streamState.final &&
      !complete
    ) {
      if (page.plainText.length < minInitialChars) {
        return false;
      }
    }

    const previousSentPreviewKey = lastSentPreviewKey;
    lastSentPreviewKey = renderedPreviewKey;
    const updateAtSend = requestedUpdates;
    const settleAuthorization = () => {
      if (requestedUpdates === updateAtSend) {
        pendingPlatformSendAuthorization = undefined;
      }
    };
    try {
      const sent = await sendMessageTransportPreview(page, sendGeneration, disableLinkPreview);
      if (sent) {
        settleAuthorization();
      }
      if (sendGeneration !== generation) {
        return true;
      }
      if (sent) {
        consecutivePreviewFailures = 0;
      }
      return sent;
    } catch (err) {
      if (sendGeneration !== generation) {
        return true;
      }
      const isEdit = typeof streamMessageId === "number";
      if (isEdit && isTelegramMessageNotModifiedError(err)) {
        // Telegram already shows exactly this text; count the edit as delivered.
        settleAuthorization();
        consecutivePreviewFailures = 0;
        streamMessageSnapshot = toDraftSnapshot(page);
        return true;
      }
      // Roll back the dedupe snapshot so the retried tick is not skipped as a no-op.
      lastSentPreviewKey = previousSentPreviewKey;
      // The account limiter owns flood waits and skipped this unfinished preview;
      // the newest text stays pending for the next tick without spending the
      // preview failure budget that final delivery relies on.
      if (!streamState.final && isTelegramRateLimitError(err)) {
        return false;
      }
      // A final 429 already outlived the limiter's wait and stays retryable for
      // stop's bounded resume. Edits retry on transient network and server errors
      // (re-editing the same content is idempotent) while an unsent first preview
      // retries only on provably pre-connect failures — anything ambiguous could
      // duplicate the preview.
      const retryable =
        isTelegramRateLimitError(err) ||
        (isEdit ? isRetryableTelegramApiError(err) : isSafeToRetrySendError(err));
      consecutivePreviewFailures += 1;
      if (retryable && consecutivePreviewFailures <= MAX_CONSECUTIVE_PREVIEW_FAILURES) {
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

  const retainCurrentPage = () => {
    if (typeof streamMessageId !== "number" || !streamMessageSnapshot?.text) {
      return;
    }
    params.onRetainedPage?.({
      messageId: streamMessageId,
      textSnapshot: streamMessageSnapshot.text,
      visibleSinceMs: streamVisibleSinceMs,
    });
    observeCurrentProviderMessage();
  };

  const resolveExactRemainingPage = (plan: {
    pages: TelegramTextDeliveryPage[];
    nextPageIndex: number;
  }): TelegramTextDeliveryPage | undefined => {
    if (plan.nextPageIndex <= 0 || plan.nextPageIndex >= plan.pages.length) {
      return undefined;
    }
    const fullSourceText = plan.pages[0]?.fullSourceText;
    if (fullSourceText === undefined) {
      return undefined;
    }
    const acceptedSourceText = plan.pages
      .slice(0, plan.nextPageIndex)
      .map((page) => page.sourceText)
      .join("");
    if (!fullSourceText?.startsWith(acceptedSourceText)) {
      return undefined;
    }
    const sourceText = fullSourceText.slice(acceptedSourceText.length);
    const plainText = telegramHtmlToPlainTextFallback(sourceText);
    // Telegram applies the message limit after parsing entities. Retry the
    // intact rendered suffix when it still fits as one visible message.
    return plainText.length <= maxChars
      ? { plainText, sourceText, sourceTextMode: "html", fullSourceText, htmlText: sourceText }
      : undefined;
  };

  const sendOrEditStreamMessage = async (update: TelegramDraftUpdate): Promise<boolean> => {
    const isLazy = typeof update !== "string";
    const text = isLazy ? update.resolveText() : update;
    if (text === undefined) {
      // Sanitizer-empty newest values consume their pending slot without sending or mutating the
      // last delivered draft. Counting the consumed slot as a flush is intentional.
      return true;
    }
    if (isLazy) {
      lastRequestedPreview = undefined;
      lastRequestedText = text;
    }
    if (streamState.stopped && !streamState.final) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return false;
    }
    const fullPreview =
      lastRequestedPreview?.text === trimmed
        ? lastRequestedPreview
        : (params.renderText?.(trimmed) ?? { text: trimmed });
    // Render once, then split the transport HTML so page boundaries preserve
    // open fences, indentation, and nested tags.
    const pages =
      streamState.final && finalPagePlan
        ? finalPagePlan.pages
        : planTelegramTextDeliveryPages({
            text: fullPreview.markdownSource?.text ?? fullPreview.text,
            maxChars,
            richMessages,
            richMessage: fullPreview.richMessage,
            tableMode: fullPreview.markdownSource?.tableMode,
            ...(richMessages || fullPreview.markdownSource
              ? {}
              : {
                  textMode:
                    fullPreview.parseMode === "HTML" ? ("html" as const) : ("plain" as const),
                }),
          });
    const firstPage = pages[0];
    if (!firstPage) {
      return false;
    }
    const disableLinkPreview = fullPreview.linkPreview === false || params.linkPreview === false;
    if (!streamState.final) {
      finalPagePlan = undefined;
      const updateGeneration = generation;
      const sent = await sendOrEditPlannedPage(firstPage, fullPreview.complete, disableLinkPreview);
      // A retired send/edit may finish after repositioning. Consume it without
      // restoring old recovery text or asking the loop to retry that generation.
      if (updateGeneration !== generation) {
        return true;
      }
      if (sent) {
        lastDeliveredText = pages.length === 1 ? trimmed : firstPage.plainText.trimEnd();
      }
      return sent;
    }

    const activePlan = (finalPagePlan ??= { pages, nextPageIndex: 0 });
    for (let index = activePlan.nextPageIndex; index < pages.length; index += 1) {
      const exactRemainingPage = resolveExactRemainingPage(activePlan);
      const page = exactRemainingPage ?? pages[index]!;
      if (index > 0 && typeof streamMessageId === "number") {
        retainCurrentPage();
        resetStreamToNewMessage("page");
      }
      if (!(await sendOrEditPlannedPage(page, false, disableLinkPreview))) {
        return false;
      }
      if (finalPagePlan !== activePlan) {
        return true;
      }
      activePlan.nextPageIndex = exactRemainingPage ? pages.length : index + 1;
      if (exactRemainingPage) {
        break;
      }
    }
    finalPagePlan = undefined;
    lastDeliveredText = trimmed;
    return true;
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

  const throwTerminalDeliveryError = () => {
    if (terminalDeliveryError !== undefined) {
      throw terminalDeliveryError;
    }
  };
  const waitForInFlight = async () => {
    await loop.waitForInFlight();
    throwTerminalDeliveryError();
  };
  const flush = async () => {
    await waitForInFlight();
    if (!streamState.stopped) {
      await loop.flush();
    }
    throwTerminalDeliveryError();
  };

  const requestDraftUpdate = (
    text: string,
    preview?: TelegramDraftPreview,
    onPlatformSendDispatch?: () => Promise<void>,
    assertPlatformSendAuthorized?: () => void,
  ) => {
    if (streamState.stopped || streamState.final) {
      return;
    }
    lastRequestedPreview = preview;
    lastRequestedText = text;
    pendingPlatformSendDispatch = onPlatformSendDispatch;
    pendingPlatformSendAuthorization = assertPlatformSendAuthorized;
    requestedUpdates += 1;
    updateDraft(text);
  };

  const updatePreview = (
    preview: TelegramDraftPreview,
    assertPlatformSendAuthorized?: () => void,
  ) => {
    const text = preview.text.trimEnd();
    if (!text) {
      return;
    }
    requestDraftUpdate(text, { ...preview, text }, undefined, assertPlatformSendAuthorized);
  };

  const stop = async () => {
    const stopGeneration = generation;
    streamState.final = true;
    // Cancel only the throttle timer, preserving its pending text. Final sends
    // wait out any flood window in the account limiter.
    loop.resetThrottleWindow();
    await loop.waitForInFlight();
    throwTerminalDeliveryError();
    if (generation !== stopGeneration || streamState.stopped) {
      return;
    }
    await flush();
    if (generation !== stopGeneration || streamState.stopped) {
      return;
    }
    const finalText = lastRequestedText.trimEnd();
    if (finalText && finalText !== lastDeliveredText.trimEnd()) {
      // Bounded resume attempts for transient edit failures; flood waits are
      // honored inside each attempt by the account limiter.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (generation !== stopGeneration || streamState.stopped) {
          return;
        }
        const sent = await sendOrEditStreamMessage(finalText);
        throwTerminalDeliveryError();
        if (generation !== stopGeneration) {
          return;
        }
        if (sent) {
          loop.resetPending();
          break;
        }
        if (!finalPagePlan || streamState.stopped) {
          break;
        }
      }
    }
    streamState.final = true;
    observeCurrentProviderMessage();
    await drainProviderMessageObservations();
    pendingPlatformSendDispatch = undefined;
    pendingPlatformSendAuthorization = undefined;
  };

  /** Prepared final content not yet accepted after retained pagination pages. */
  const remainingFinalContent = (): TelegramDraftMessageSnapshot | undefined => {
    const plan = finalPagePlan;
    if (!plan || plan.nextPageIndex <= 0 || plan.nextPageIndex >= plan.pages.length) {
      return undefined;
    }
    const pages = plan.pages.slice(plan.nextPageIndex);
    const exactRemainingPage = resolveExactRemainingPage(plan);
    const exactSourceSuffix = exactRemainingPage?.sourceText;
    const sourceText =
      exactSourceSuffix ||
      pages
        .map((page) =>
          page.sourceTextMode === "html" ? page.sourceText : escapeTelegramHtml(page.plainText),
        )
        .join("");
    return {
      text: exactRemainingPage?.plainText ?? pages.map((page) => page.plainText).join(""),
      // Pagination has already rendered the final. Carry concrete HTML forward;
      // reparsing visible page text as Markdown can change code, links, and tags.
      sourceText,
      sourceTextMode: "html",
    };
  };

  const resetStreamToNewMessage = (mode: "page" | "retain" | "replace") => {
    const continueFinalPagination = mode === "page";
    if (mode === "retain") {
      observeCurrentProviderMessage();
    }
    streamState.stopped = false;
    streamState.final = continueFinalPagination;
    if (!continueFinalPagination) {
      generation += 1;
    }
    messageSendAttempted = false;
    streamMessageId = undefined;
    streamMessageSnapshot = undefined;
    streamProviderMessage = undefined;
    streamVisibleSinceMs = undefined;
    lastSentPreviewKey = "";
    if (!continueFinalPagination) {
      finalPagePlan = undefined;
      lastRequestedText = "";
      lastDeliveredText = "";
      loop.resetPending();
      lastRequestedPreview = undefined;
      // The dropped pending update takes its send authority with it.
      pendingPlatformSendAuthorization = undefined;
      requestedUpdates += 1;
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
        const deleted = await params.api.deleteMessage(chatId, messageId);
        if (!deleted) {
          params.warn?.(
            `telegram stream preview cleanup was not confirmed (chat=${chatId}, message=${messageId})`,
          );
          return;
        }
        if (replyTargetState.kind === "retained" && replyTargetState.messageId === messageId) {
          replyTargetState = { kind: "available" };
        }
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

  const retireSupersededPreviews = () => {
    const previews = supersededPreviews;
    supersededPreviews = [];
    for (const { messageId, visibleSinceMs } of previews) {
      scheduleDetachedDelete(messageId, visibleSinceMs, REPOSITION_DELETE_DELAY_MS);
    }
  };
  const retireWhenReplaced = (messageId: number, visibleSinceMs: number | undefined) => {
    supersededPreviews.push({ messageId, visibleSinceMs });
    if (typeof streamMessageId === "number") {
      retireSupersededPreviews();
    }
  };

  const clear = async () => {
    retireSupersededPreviews();
    const visibleSince = streamVisibleSinceMs;
    const messageId = await takeMessageIdAfterStop({
      stopForClear,
      readMessageId: () => streamMessageId,
      clearMessageId: () => {
        streamMessageId = undefined;
        streamMessageSnapshot = undefined;
        streamProviderMessage = undefined;
      },
    });
    // Joining a rotated first send can add a late-accepted superseded preview.
    retireSupersededPreviews();
    if (typeof messageId === "number" && Number.isFinite(messageId)) {
      scheduleDetachedDelete(messageId, visibleSince);
    }
    await drainProviderMessageObservations();
  };

  const REPOSITION_DELETE_DELAY_MS = 1_500;
  /** Rewind and delete the superseded preview only after its replacement lands. */
  const rotateToNewMessageDeferringDelete = (): void => {
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
    resetStreamToNewMessage("replace");
    if (typeof supersededMessageId === "number" && Number.isFinite(supersededMessageId)) {
      retireWhenReplaced(supersededMessageId, supersededVisibleSince);
    }
  };

  params.log?.(`telegram stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update: (
      text: string,
      options?: {
        onPlatformSendDispatch?: () => Promise<void>;
        assertPlatformSendAuthorized?: () => void;
      },
    ) =>
      requestDraftUpdate(
        text,
        undefined,
        options?.onPlatformSendDispatch,
        options?.assertPlatformSendAuthorized,
      ),
    // An accepted lazy update replaces the pending one and carries no send
    // authority; stopped or final streams ignore it and keep the pending update's.
    updateLazy: (resolveText: () => string | undefined) => {
      if (streamState.stopped || streamState.final) {
        return;
      }
      pendingPlatformSendAuthorization = undefined;
      requestedUpdates += 1;
      updateDraft({ resolveText });
    },
    updatePreview,
    flush,
    waitForInFlight,
    messageId: () => streamMessageId,
    lastDeliveredText: () => lastDeliveredText,
    /** A failed preview stops editing for good; it can no longer carry live progress. */
    isStopped: () => streamState.stopped,
    currentMessageSnapshot: (): TelegramDraftMessageSnapshot | undefined => {
      const ownsReplyTarget =
        !consumesReplyTarget ||
        (replyTargetState.kind === "retained" && replyTargetState.messageId === streamMessageId);
      return streamMessageSnapshot && ownsReplyTarget && replyToMessageId !== undefined
        ? { ...streamMessageSnapshot, replyToMessageId }
        : streamMessageSnapshot;
    },
    clear,
    stop,
    /** Stop without a final flush or delete. */
    discard: async () => {
      await stopForClear();
      observeCurrentProviderMessage();
      await drainProviderMessageObservations();
    },
    remainingFinalContent,
    /** True while a pending or visible draft owns a first/batched reply target. */
    hasConsumedReplyTarget: () => replyTargetState.kind !== "available",
    /** Reset internal state so the next update creates a new message instead of editing. */
    forceNewMessage: () => resetStreamToNewMessage("retain"),
    rotateToNewMessageDeferringDelete,
    /** True when a preview sendMessage was attempted but the response was lost. */
    sendMayHaveLanded: () => messageSendAttempted && typeof streamMessageId !== "number",
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

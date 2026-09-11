import {
  type AgentPlanStep,
  createChannelProgressDraftCompositor,
  createChannelProgressWorkCounter,
  createDraftStreamLoop,
  resolveChannelProgressDraftMaxLineChars,
  resolveChannelStreamingPreviewToolProgress,
  resolveChannelStreamingSuppressDefaultToolProgressMessages,
  type ChannelProgressDraftCompositorSnapshot,
} from "openclaw/plugin-sdk/channel-outbound";
import type { ReplyDispatchKind, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { createSlackDraftStream } from "../../draft-stream.js";
import { formatSlackError } from "../../errors.js";
import { SLACK_EDIT_TEXT_MAX_BYTES, SLACK_TEXT_LIMIT } from "../../limits.js";
import { applyAppendOnlyStreamUpdate } from "../../stream-mode.js";
import { appendSlackStream } from "../../streaming.js";
import {
  resolveExplicitSlackProgressTitle,
  resolveSlackProgressReasoningMode,
  resolveSlackProgressStyle,
} from "./dispatch-helpers.js";
import {
  createSlackDraftProgressCardRuntime,
  formatSlackProgressDraftLine,
} from "./dispatch-progress-card.js";
import { createSlackNativeProgressTransport } from "./dispatch-progress-native.js";
import {
  createSlackReasoningCardsRuntime,
  withSlackReasoningCardsWindow,
} from "./dispatch-progress-reasoning.js";
import {
  combineProgressHeadlineAndExplanation,
  resolveNativeProgressNarration,
} from "./dispatch-progress-render.js";
import { createSlackNativeProgressStream } from "./dispatch-progress-stream.js";
import type { SlackDispatchSetup } from "./dispatch-setup.js";
import type { SlackStreamingDeliveryRuntime } from "./dispatch-streaming.js";

export function createSlackProgressRuntime(runtimeParams: {
  setup: SlackDispatchSetup;
  delivery: SlackStreamingDeliveryRuntime;
  resetPreviewDeliveryState: () => void;
}) {
  const { setup, delivery, resetPreviewDeliveryState } = runtimeParams;
  const {
    account,
    cfg,
    ctx,
    hasSlackCustomIdentity,
    message,
    prepared,
    replyPlan,
    runtime,
    slackClient,
    slackIdentity,
    slackMessageMetadata,
    slackStreaming,
    shouldUseDraftStream,
    useStreaming,
    previewStreamingEnabled,
  } = setup;
  const draftStream = shouldUseDraftStream
    ? createSlackDraftStream({
        target: prepared.replyTarget,
        cfg,
        token: ctx.botToken,
        accountId: account.accountId,
        conversationChannelId: message.channel,
        eventScope: prepared.eventScope,
        // Impersonated Slack messages cannot be deleted. Keep the temporary
        // preview app-authored and apply custom identity only to final delivery.
        ...(!hasSlackCustomIdentity && slackIdentity ? { identity: slackIdentity } : {}),
        ...(slackMessageMetadata ? { metadata: slackMessageMetadata } : {}),
        maxChars: Math.min(ctx.textLimit, SLACK_TEXT_LIMIT),
        resolveThreadTs: () => {
          const ts = replyPlan.peekThreadTs();
          if (ts) {
            delivery.usedReplyThreadTs ??= ts;
          }
          return ts;
        },
        log: logVerbose,
        warn: logVerbose,
      })
    : undefined;
  let hasStreamedAnswer = false;
  const isProgressMode = slackStreaming.mode === "progress";
  const useNativeProgressStreaming = useStreaming && slackStreaming.mode === "progress";
  const progressDraftActive = Boolean(draftStream) || useNativeProgressStreaming;
  const previewToolProgressEnabled =
    progressDraftActive &&
    resolveChannelStreamingPreviewToolProgress(
      account.config,
      slackStreaming.mode !== "progress",
      slackStreaming.mode,
    );
  let shouldYieldDraftProgress: () => boolean = () => false;
  const suppressDefaultToolProgressMessages =
    resolveChannelStreamingSuppressDefaultToolProgressMessages(account.config, {
      draftStreamActive: Boolean(draftStream) || useNativeProgressStreaming,
      mode: slackStreaming.mode,
      previewToolProgressEnabled,
      previewStreamingEnabled,
    });
  let appendRenderedText = "";
  let appendSourceText = "";
  // Terminal status of the turn's final payload; completion retries and
  // queued rotation must not repaint an errored turn as complete.
  let nativeProgressTerminalStatus: "complete" | "error" = "complete";
  // Native streaming appends; overlapping updates would re-append identical
  // narration/chunks because delta state commits only after network success.
  // One chain keeps each update's compute -> append -> commit atomic.
  let nativeStreamOrder: Promise<unknown> = Promise.resolve();
  // Chain tasks in progress. A compositor publish that lands while one runs
  // (a card released from inside a send, an event arriving during a Slack
  // call) must not wait for the send it is part of.
  let nativeStreamOrderDepth = 0;
  // Compositor publishes awaiting the pacing loop's flush. The gate's startup
  // render is one: it holds the gate's start promise until the first send
  // returns, and a card released into the compositor from inside that send
  // would wait on that promise. The loop's own send defers such a release to
  // the next paced send; any other chain task waits for the flush to settle.
  let compositorFlushesPending = 0;
  let compositorFlushesSettled: Promise<void> = Promise.resolve();
  let settleCompositorFlushes: (() => void) | undefined;
  let loopSendInFlight = false;
  const noteCompositorFlush = (delta: 1 | -1) => {
    compositorFlushesPending += delta;
    if (compositorFlushesPending === 1 && delta === 1) {
      compositorFlushesSettled = new Promise<void>((resolve) => {
        settleCompositorFlushes = resolve;
      });
    } else if (compositorFlushesPending === 0) {
      settleCompositorFlushes?.();
      settleCompositorFlushes = undefined;
    }
  };
  const withNativeStreamOrder = <T>(task: () => Promise<T>): Promise<T> => {
    const ordered = async () => {
      nativeStreamOrderDepth += 1;
      try {
        return await task();
      } finally {
        nativeStreamOrderDepth -= 1;
      }
    };
    const run = nativeStreamOrder.then(ordered, ordered);
    nativeStreamOrder = run.catch(() => undefined);
    return run;
  };
  const progressWorkCounter = createChannelProgressWorkCounter();
  const progressSeed = `${account.accountId}:${message.channel}`;
  const slackProgressStyle = resolveSlackProgressStyle(account.config);
  // THIS BEHAVIOR IS INTENTIONAL AND MUST NOT BE CASUALLY ADJUSTED.
  // DO NOT CHANGE THIS WITHOUT APPROVAL FROM SJF OR PASHPASHPASH.
  const useDraftProgressCard =
    Boolean(draftStream) && isProgressMode && slackProgressStyle === "card";
  const explicitProgressTitle = resolveExplicitSlackProgressTitle(account.config);
  // Reasoning cards are task rows, so they need the detailed native card; the
  // quiet card keeps one summary row and leaves reasoning in the narration text.
  const useReasoningCards =
    useNativeProgressStreaming &&
    previewToolProgressEnabled &&
    resolveSlackProgressReasoningMode(account.config) === "cards";
  // A long think fills a message past Slack's size for one streamed message.
  // Cards mode chains messages: a full message finishes as "continued below"
  // and the turn goes on in a continuation in the same thread. Narration mode
  // keeps reasoning to one compacted line and is left as it was.
  const useStreamRollover = useReasoningCards;
  const progressCompositorEntry = useReasoningCards
    ? withSlackReasoningCardsWindow(account.config)
    : account.config;
  const reasoningCards = createSlackReasoningCardsRuntime({
    enabled: useReasoningCards,
    compositor: () => progressDraft,
    admits: (line) => nativeStream.admitsRow(line),
    flushQueued: () => withNativeStreamOrder(() => nativeStream.drain()),
    noteQueued: () => nativeUpdates.update(true),
  });
  const progressDraftMaxLineChars = resolveChannelProgressDraftMaxLineChars(account.config);
  const progressCard = createSlackDraftProgressCardRuntime({
    setup: { account, cfg, ctx, prepared, slackClient },
    draftStream,
    enabled: useDraftProgressCard,
    progressWorkCounter: previewToolProgressEnabled ? progressWorkCounter : undefined,
    progressSeed,
    explicitTitle: explicitProgressTitle,
    maxLineChars: progressDraftMaxLineChars,
    getSnapshot: () => progressDraft.getSnapshot(),
    getThreadTs: () => delivery.usedReplyThreadTs,
  });
  const nativeTransport = createSlackNativeProgressTransport({ setup, delivery });
  // Card-only cleanup. Other draft modes abandon a preview holding streamed
  // assistant text the human already replied to; that message stays visible.
  const dropDetachedProgressCards = async () => {
    if (!useDraftProgressCard) {
      return;
    }
    await draftStream?.dropDetachedMessages();
  };

  const resolveNativeProgressTitle = (snapshot: ChannelProgressDraftCompositorSnapshot) =>
    combineProgressHeadlineAndExplanation(
      explicitProgressTitle ?? snapshot.statusHeadline,
      snapshot.planExplanation,
    );

  // The finished card summarizes the think instead of keeping the running
  // headline; an explicit progress title still wins.
  const resolveNativeProgressCompletionTitle = (
    snapshot: ChannelProgressDraftCompositorSnapshot,
  ) =>
    explicitProgressTitle !== undefined
      ? resolveNativeProgressTitle(snapshot)
      : combineProgressHeadlineAndExplanation(
          reasoningCards.summaryTitle() ?? snapshot.statusHeadline,
          snapshot.planExplanation,
        );

  const nativeStream = createSlackNativeProgressStream({
    delivery,
    transport: nativeTransport,
    replyPlan,
    runtime,
    rollover: useStreamRollover,
    explicitTitle: explicitProgressTitle,
    maxLineChars: progressDraftMaxLineChars,
    summaryRow: !previewToolProgressEnabled,
    getSnapshot: () => progressDraft.getSnapshot(),
    resolveTitle: resolveNativeProgressTitle,
    resolveCompletionTitle: resolveNativeProgressCompletionTitle,
    resolveSessionUrl: () => progressCard.resolveSessionUrl(),
    onRolled: (throughCard) => reasoningCards.rollover(throughCard),
    pendingRows: () => reasoningCards.pendingRows(),
    releasePending: async () => {
      if (compositorFlushesPending > 0) {
        if (loopSendInFlight) {
          return undefined;
        }
        await compositorFlushesSettled;
      }
      return await reasoningCards.release();
    },
    peekPendingLines: () => reasoningCards.peekPendingLines(),
    markPendingPlaced: (lineIds) => reasoningCards.markPlaced(lineIds),
  });
  const buildNativeProgressCompletionChunks = nativeStream.buildCompletionChunks;

  const appendNativeProgressCompletion = async (isError: boolean) => {
    const session = delivery.streamSession;
    if (isError) {
      nativeProgressTerminalStatus = "error";
    }
    if (!session || nativeStream.completionSent || delivery.isStoppedBySlack()) {
      return;
    }
    const chunks = buildNativeProgressCompletionChunks(isError ? "error" : "complete");
    const narrationUpdate = nativeStream.resolveNarrationUpdate(
      resolveNativeProgressNarration(progressDraft.getSnapshot()),
    );
    if (!chunks?.length && !narrationUpdate.delta) {
      return;
    }
    try {
      delivery.streamLedger.record({ chunks });
      await appendSlackStream({ session, chunks });
      nativeStream.commitNarration(narrationUpdate.next);
      nativeStream.completionSent = true;
      delivery.observedReplyDelivery ||= session.delivered;
    } catch (err) {
      delivery.streamFailed = true;
      runtime.error?.(
        danger(`slack-stream: native progress completion failed: ${formatSlackError(err)}`),
      );
    }
  };

  const normalizeProgressText = (text: string | undefined) =>
    text?.replace(/\s+/gu, " ").trim() ?? "";

  const isRenderedAsProgressTitle = (text: string | undefined): boolean => {
    const candidate = normalizeProgressText(text);
    if (!candidate) {
      return false;
    }
    const title = normalizeProgressText(resolveNativeProgressTitle(progressDraft.getSnapshot()));
    return title.length > 0 && title.includes(candidate);
  };

  // Rows still queued when the turn ends go out through the rollover owner,
  // budgeted and rolling as needed, before any closeout: a completion append
  // or stop carrying them could pass Slack's size or its 50-row plan block.
  // A send settles unless a start was not accepted or the compositor refused
  // a release; the few passes cover the former, and cards still queued after
  // them are placed straight from the queue on budgeted messages. `Now` runs
  // inside the transport chain, before a final that does not stream; the
  // other form joins the chain for the silent closeout and turn rotation,
  // where a final that streamed already drained the rows itself.
  let nativeFinalDelivered = false;
  const drainNativeProgressBeforeCloseNow = async (): Promise<void> => {
    if (
      !useStreamRollover ||
      !delivery.streamSession ||
      delivery.streamFailed ||
      delivery.isStoppedBySlack()
    ) {
      return;
    }
    await nativeStream.drain();
    nativeStream.admitPlanForCompletion();
  };
  const drainNativeProgressBeforeClose = async (): Promise<void> => {
    if (nativeFinalDelivered || nativeStream.completionSent) {
      return;
    }
    await withNativeStreamOrder(drainNativeProgressBeforeCloseNow);
  };

  const updateNativeProgressStreamNow = async (): Promise<boolean> => {
    if (!useNativeProgressStreaming || delivery.streamFailed || nativeUpdatesStopped) {
      return false;
    }
    const canContinue = await nativeTransport.waitForStart();
    if (!canContinue) {
      return false;
    }
    return (await nativeStream.send()).sent;
  };

  let nativeUpdatesStopped = false;
  // Read the latest compositor snapshot only when the batch sends. Terminal
  // delivery cancels pending batches before joining the same transport chain.
  const nativeUpdates = createDraftStreamLoop<boolean>({
    throttleMs: 1_000,
    coalesceInFlight: true,
    emptyValue: false,
    isEmpty: (pending) => !pending,
    isStopped: () => nativeUpdatesStopped,
    sendOrEditStreamMessage: () =>
      withNativeStreamOrder(async () => {
        loopSendInFlight = true;
        try {
          return await updateNativeProgressStreamNow();
        } finally {
          loopSendInFlight = false;
        }
      }),
    onBackgroundFlushError: (err) =>
      runtime.error?.(danger(`slack-stream: progress update failed: ${formatSlackError(err)}`)),
  });
  const cancelNativeUpdates = async () => {
    nativeUpdatesStopped = true;
    nativeUpdates.stop();
    await nativeUpdates.waitForInFlight();
  };

  const appendNativeNarration = (
    payload: ReplyPayload,
    kind: ReplyDispatchKind,
  ): Promise<boolean> => withNativeStreamOrder(() => appendNativeNarrationNow(payload, kind));

  const appendNativeNarrationNow = async (
    payload: ReplyPayload,
    kind: ReplyDispatchKind,
  ): Promise<boolean> => {
    // The same preamble reaches us as a reply payload and as the compositor
    // headline behind the card title. The card updates it in place, so
    // streaming it as text too would print the line twice.
    if (isRenderedAsProgressTitle(payload.text)) {
      return false;
    }
    const narrationUpdate = nativeStream.resolveNarrationUpdate(payload.text?.trimEnd());
    if (!narrationUpdate.delta) {
      return false;
    }
    if (!(await nativeStream.ensureRoomForNarration(narrationUpdate.delta))) {
      return false;
    }
    await delivery.deliverWithStreaming({
      payload,
      kind,
      streamText: narrationUpdate.delta,
      appendSeparator: false,
      taskDisplayMode: "plan",
      ...(useStreamRollover ? { onMessageTooLong: nativeStream.retryNarrationOnNewMessage } : {}),
    });
    if (!delivery.streamFailed) {
      nativeStream.commitNarration(narrationUpdate.next);
    }
    return true;
  };

  const resetProgressTurnState = () => {
    progressWorkCounter.reset();
    reasoningCards.reset();
    nativeStream.reset();
    nativeFinalDelivered = false;
  };

  const progressDraft = createChannelProgressDraftCompositor({
    entry: progressCompositorEntry,
    mode: slackStreaming.mode,
    active: progressDraftActive,
    seed: progressSeed,
    formatLine: formatSlackProgressDraftLine,
    reasoningLinePrefix: "🧠 ",
    updateOnLineChange: useNativeProgressStreaming || useDraftProgressCard,
    update: async (previewText, options) => {
      if (useNativeProgressStreaming) {
        const priorSnapshot = nativeStream.snapshot;
        const priorNarration = nativeStream.narrationRenderedText;
        nativeUpdates.update(true);
        if (nativeStreamOrderDepth > 0) {
          // Inside a chain task: the send in progress reads the lines itself
          // or the loop follows up; waiting here would wait on ourselves.
          return false;
        }
        if (options?.flush) {
          noteCompositorFlush(1);
          try {
            await nativeUpdates.flush();
          } finally {
            noteCompositorFlush(-1);
          }
        } else {
          await nativeUpdates.waitForInFlight();
        }
        return (
          priorSnapshot !== nativeStream.snapshot ||
          priorNarration !== nativeStream.narrationRenderedText
        );
      }
      if (!draftStream) {
        return false;
      }
      const snapshot = options.snapshot;
      progressCard.setFallbackText(previewText);
      draftStream.update(
        useDraftProgressCard
          ? {
              text: previewText,
              blocks: progressCard.resolvePresentation(snapshot, "working"),
            }
          : previewText,
      );
      if (options?.flush) {
        await draftStream.flush();
      }
      return Boolean(draftStream.messageId() && draftStream.channelId());
    },
    deleteCurrent: async () => {
      if (useNativeProgressStreaming) {
        // Native streams append task changes; clearing a plan retires its task rows.
        nativeUpdates.update(true);
        await nativeUpdates.flush();
      } else {
        await draftStream?.clear();
        draftStream?.forceNewMessage();
      }
    },
  });
  const commentaryProgressEnabled = progressDraft.commentaryProgressEnabled;

  // Core fires onReasoningEnd and onAssistantMessageStart best effort, not
  // awaited, so with a live model a draft boundary can arrive while the final
  // reply is being delivered (the seal's append is still in flight when the run
  // ends). A boundary that lands then must wait for the answer to reach its
  // message; otherwise it would stop the stream and reset the turn under it.
  let finalDelivery: Promise<void> | null = null;

  const deliverNativeFinal = async (
    payload: ReplyPayload,
    kind: ReplyDispatchKind,
  ): Promise<void> => {
    // The pacing loop stops now (synchronously); the compositor's final mark
    // waits until the queued rows have drained, since it refuses new lines.
    const run = (async () => {
      await cancelNativeUpdates();
      await withNativeStreamOrder(() => deliverNativeFinalNow(payload, kind));
    })();
    finalDelivery = run.catch(() => undefined);
    try {
      await run;
    } finally {
      finalDelivery = null;
    }
  };

  const deliverNativeFinalNow = async (payload: ReplyPayload, kind: ReplyDispatchKind) => {
    const streamReady = await nativeTransport.waitForStart();
    const finalThreadTs = delivery.streamSession?.threadTs ?? delivery.nativeProgressStreamThreadTs;
    // Optional progress may still be buffered locally. Join its stream so
    // final delivery cannot leave a second message to be flushed by stop.
    const canFinishInStream =
      payload.isError !== true &&
      streamReady &&
      Boolean(delivery.streamSession) &&
      delivery.isStreamingEligible(payload, { maxTextBytes: SLACK_EDIT_TEXT_MAX_BYTES });
    if (canFinishInStream) {
      await nativeStream.prepareForAnswer(payload);
    } else {
      await drainNativeProgressBeforeCloseNow();
    }
    progressDraft.markFinalReplyStarted();
    if (canFinishInStream && !delivery.streamFailed) {
      // Flush the terminal task row before buffering the answer so Slack
      // preserves narration -> plan -> final answer ordering.
      await appendNativeProgressCompletion(false);
      await delivery.deliverWithStreaming({
        payload,
        kind,
        // The chain's thread, in case the think was finished and the answer streams alone.
        ...(useStreamRollover && finalThreadTs ? { forcedThreadTs: finalThreadTs } : {}),
        ...(useStreamRollover ? { onMessageTooLong: nativeStream.retryAnswerOnNewMessage } : {}),
      });
    } else {
      await delivery.deliverNormally({ payload, kind, forcedThreadTs: finalThreadTs });
      await appendNativeProgressCompletion(payload.isError === true);
    }
    nativeFinalDelivered = true;
    progressDraft.markFinalReplyDelivered();
  };

  const finishNativeProgressTurn = async (
    completionChunks: ReturnType<typeof buildNativeProgressCompletionChunks>,
  ) => {
    if (delivery.nativeProgressStreamStartPromise) {
      await delivery.nativeProgressStreamStartPromise.catch(() => null);
    }
    if (completionChunks?.length) {
      nativeStream.completionSent = true;
    }
    await delivery.finishStream(completionChunks);
    delivery.streamSession = null;
    delivery.nativeProgressStreamStartPromise = null;
    delivery.nativeProgressStreamThreadTs = undefined;
    delivery.streamFailed = false;
    delivery.stoppedBySlack = false;
  };

  const pushPlanProgress = async (steps?: AgentPlanStep[], explanation?: string) => {
    if (isProgressMode && slackProgressStyle === "compact") {
      return false;
    }
    return await progressDraft.pushPlanProgress(steps, { explanation });
  };

  const updateDraftFromPartial = (text?: string) => {
    const trimmed = text && sanitizeAssistantVisibleText(text).trimEnd();
    if (!trimmed) {
      return false;
    }

    if (slackStreaming.mode === "block") {
      progressDraft.resetActivity({ suppressed: true });
      const next = applyAppendOnlyStreamUpdate({
        incoming: trimmed,
        rendered: appendRenderedText,
        source: appendSourceText,
      });
      appendRenderedText = next.rendered;
      appendSourceText = next.source;
      if (!next.changed) {
        return false;
      }
      draftStream?.update(next.rendered);
      hasStreamedAnswer = true;
      return false;
    }

    if (isProgressMode) {
      return false;
    }

    progressDraft.resetActivity({ suppressed: true });
    draftStream?.update(trimmed);
    hasStreamedAnswer = true;
    return false;
  };
  const pushReasoningProgress = async (payload?: {
    text?: string;
    isReasoningSnapshot?: boolean;
  }) => {
    if (!payload?.text) {
      return false;
    }
    if (!isProgressMode) {
      const normalized = progressDraft
        .mergeReasoningProgress(payload.text, {
          snapshot: payload.isReasoningSnapshot === true,
        })
        .replace(/^_(.*)_$/su, "$1")
        .trim();
      if (!normalized) {
        return false;
      }
      const visible = await progressDraft.pushToolProgress({
        id: "reasoning",
        kind: "item",
        text: normalized,
        label: "Reasoning",
      });
      // Tool admission closes reasoning bursts; restore this still-open preview lane.
      progressDraft.mergeReasoningProgress(normalized, { snapshot: true });
      return visible;
    }
    if (reasoningCards.enabled) {
      return await reasoningCards.push({
        text: payload.text,
        isReasoningSnapshot: payload.isReasoningSnapshot,
      });
    }
    return await progressDraft.pushReasoningProgress(payload.text, {
      snapshot: payload.isReasoningSnapshot === true,
    });
  };
  const resetDraftDeliveryState = () => {
    hasStreamedAnswer = false;
    appendRenderedText = "";
    appendSourceText = "";
  };
  const beginNewProgressTurn = async (options?: { force?: boolean }) => {
    if (useNativeProgressStreaming) {
      if (!nativeUpdatesStopped && options?.force !== true) {
        return false;
      }
      if (options?.force !== true && finalDelivery) {
        await finalDelivery;
      }
      await cancelNativeUpdates();
      await drainNativeProgressBeforeClose();
    }
    const priorSnapshot = progressDraft.getSnapshot();
    const priorFallbackText = progressCard.resolveText(priorSnapshot);
    const completionChunks =
      useNativeProgressStreaming && !nativeStream.completionSent
        ? buildNativeProgressCompletionChunks(nativeProgressTerminalStatus)
        : undefined;
    if (!progressDraft.beginNewTurn(options)) {
      return false;
    }
    // Native messages are one-shot streams. Stop the prior turn before the
    // reset compositor can publish the queued turn's first snapshot.
    if (useNativeProgressStreaming) {
      await finishNativeProgressTurn(completionChunks);
    } else {
      await progressCard.finalize("success", priorSnapshot, priorFallbackText);
      draftStream?.forceNewMessage();
      await dropDetachedProgressCards();
    }
    resetProgressTurnState();
    nativeProgressTerminalStatus = "complete";
    nativeUpdatesStopped = false;
    nativeUpdates.resetThrottleWindow();
    progressCard.reset();
    // A re-armed turn is a new visible reply: it must not dedupe against or
    // inherit delivery state from the settled turn (mirrors queued admission).
    resetPreviewDeliveryState();
    delivery.resetDeliveryTracker();
    return true;
  };
  const onDraftBoundary =
    !shouldUseDraftStream && !useNativeProgressStreaming
      ? undefined
      : async () => {
          if (isProgressMode) {
            await beginNewProgressTurn();
            progressDraft.beginAssistantMessage();
            return;
          }
          if (hasStreamedAnswer) {
            draftStream?.forceNewMessage();
          }
          resetDraftDeliveryState();
          progressDraft.beginAssistantMessage();
        };

  const onQueuedFollowupAdmitted =
    !shouldUseDraftStream && !useNativeProgressStreaming
      ? undefined
      : async () => {
          // A queued input is a new visible reply even though it drains through
          // this turn's callbacks. Do not let it edit or dedupe against this run.
          await draftStream?.flush();
          resetPreviewDeliveryState();
          if (isProgressMode) {
            await beginNewProgressTurn({ force: true });
          } else {
            draftStream?.forceNewMessage();
          }
          delivery.resetDeliveryTracker();
          resetDraftDeliveryState();
          progressDraft.reset();
        };
  // A queued turn can drain after its dispatch returned, so dispatch closeout is
  // no longer available to settle the card it published. Leave none in Working.
  const onQueuedFollowupSettled =
    !useDraftProgressCard && !useNativeProgressStreaming
      ? undefined
      : async () => {
          if (useNativeProgressStreaming) {
            progressDraft.markFinalReplyStarted();
            await cancelNativeUpdates();
            await drainNativeProgressBeforeClose();
            await finishNativeProgressTurn(
              nativeStream.completionSent
                ? undefined
                : buildNativeProgressCompletionChunks(nativeProgressTerminalStatus),
            );
            progressDraft.markFinalReplyDelivered();
            return;
          }
          if (!progressCard.hasTerminalized) {
            await draftStream?.clear();
          }
          await dropDetachedProgressCards();
        };

  return {
    draftStream,
    isProgressMode,
    useDraftProgressCard,
    useNativeProgressStreaming,
    progressDraftActive,
    previewToolProgressEnabled,
    suppressDefaultToolProgressMessages,
    progressDraft,
    progressWorkCounter,
    commentaryProgressEnabled,
    async cancel() {
      progressDraft.cancel();
      await cancelNativeUpdates();
    },
    get nativeProgressCompletionSent() {
      return nativeStream.completionSent;
    },
    set nativeProgressCompletionSent(value: boolean) {
      nativeStream.completionSent = value;
    },
    get nativeProgressTerminalStatus() {
      return nativeProgressTerminalStatus;
    },
    appendNativeNarration,
    buildNativeProgressCompletionChunks,
    deliverNativeFinal,
    drainNativeProgressBeforeClose,
    dropDetachedProgressCards,
    finalizeDraftProgressCard: progressCard.finalize,
    onDraftBoundary,
    onQueuedFollowupAdmitted,
    onQueuedFollowupSettled,
    pushPlanProgress,
    pushReasoningProgress,
    noteReasoningToolCall: reasoningCards.noteToolCall,
    sealReasoningCards: reasoningCards.seal,
    updateDraftFromPartial,
    setShouldYieldDraftProgress: (value: () => boolean) => {
      shouldYieldDraftProgress = value;
    },
    shouldYieldDraftProgress: () => shouldYieldDraftProgress(),
  };
}

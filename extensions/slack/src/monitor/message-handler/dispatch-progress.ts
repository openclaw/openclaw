import {
  type AgentPlanStep,
  createChannelProgressDraftCompositor,
  createChannelProgressWorkCounter,
  createDraftStreamLoop,
  createLivePreviewLifecycle,
  resolveChannelProgressDraftMaxLineChars,
  resolveChannelStreamingPreviewToolProgress,
  resolveChannelStreamingSuppressDefaultToolProgressMessages,
  type ChannelProgressDraftCompositorSnapshot,
  type LivePreviewDeliveryResult,
} from "openclaw/plugin-sdk/channel-outbound";
import type { ReplyDispatchKind, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { createSlackDraftStream } from "../../draft-stream.js";
import { formatSlackError } from "../../errors.js";
import { SLACK_TEXT_LIMIT } from "../../limits.js";
import {
  buildSlackProgressStreamChunks,
  buildSlackProgressTextBlocks,
  reconcileSlackNativeTaskChunks,
  EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
  type SlackNativeStreamSnapshot,
} from "../../progress-blocks.js";
import { applyAppendOnlyStreamUpdate } from "../../stream-mode.js";
import { appendSlackStream } from "../../streaming.js";
import { resolveExplicitSlackProgressTitle } from "./dispatch-helpers.js";
import {
  createSlackDraftProgressCardRuntime,
  formatSlackProgressDraftLine,
} from "./dispatch-progress-card.js";
import { createSlackNativeProgressTransport } from "./dispatch-progress-native.js";
import {
  combineProgressHeadlineAndExplanation,
  isSlackProgressTitleText,
  resolveNativeProgressLines,
  resolveNativeProgressNarration,
} from "./dispatch-progress-render.js";
import type { SlackDispatchSetup } from "./dispatch-setup.js";
import type { SlackStreamingDeliveryRuntime } from "./dispatch-streaming.js";

export function createSlackProgressRuntime(runtimeParams: {
  setup: SlackDispatchSetup;
  delivery: SlackStreamingDeliveryRuntime;
}) {
  const { setup, delivery } = runtimeParams;
  const {
    cfg,
    hasSlackCustomIdentity,
    prepared,
    replyPlan,
    runtime,
    slackIdentity,
    slackStreaming,
    slackProgressStyle,
    quietProgress,
    shouldUseDraftStream,
    useStreaming,
    previewStreamingEnabled,
  } = setup;
  const { account, ctx, message, slackMessageMetadata } = prepared;
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
  const suppressDefaultToolProgressMessages =
    quietProgress ||
    resolveChannelStreamingSuppressDefaultToolProgressMessages(account.config, {
      draftStreamActive: Boolean(draftStream) || useNativeProgressStreaming,
      mode: slackStreaming.mode,
      previewToolProgressEnabled,
      previewStreamingEnabled,
    });
  // Plan title and task rows already delivered to the native stream; the
  // reconciler diffs each snapshot against it and terminalizes ids that drop
  // out (plan shrinks, summary <-> plan source switches).
  let nativeStreamSnapshot: SlackNativeStreamSnapshot = EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT;
  let nativeSnapshotSession = delivery.streamSession;
  let appendState = { rendered: "", source: "" };
  let nativeProgressCompletionSent = false;
  // A requested card post may still be queued or in flight without a message id.
  let cardPostRequested = false;
  // Terminal status of the turn's final payload; completion retries and
  // queued rotation must not repaint an errored turn as complete.
  let nativeProgressTerminalStatus: "complete" | "error" = "complete";
  let nativeNarration = { rendered: "", source: "" };
  // Native streaming appends; overlapping updates would re-append identical
  // narration/chunks because delta state commits only after network success.
  // One chain keeps each update's compute -> append -> commit atomic.
  let nativeStreamOrder: Promise<unknown> = Promise.resolve();
  const withNativeStreamOrder = <T>(task: () => Promise<T>): Promise<T> => {
    const run = nativeStreamOrder.then(task, task);
    nativeStreamOrder = run.catch(() => undefined);
    return run;
  };
  const progressWorkCounter = createChannelProgressWorkCounter();
  const progressSeed = `${account.accountId}:${message.channel}`;
  // Compact quiet Slack is the latest model preamble, not the shared progress
  // card's summary. Keep reasoning and tool telemetry (including failures and
  // edit counters) out of this lane when refactoring channel presentation.
  const preambleOnlyProgress =
    isProgressMode && slackProgressStyle === "compact" && !previewToolProgressEnabled;
  // THIS BEHAVIOR IS INTENTIONAL AND MUST NOT BE CASUALLY ADJUSTED.
  // DO NOT CHANGE THIS WITHOUT APPROVAL FROM SJF OR PASHPASHPASH.
  const useDraftProgressCard =
    Boolean(draftStream) && isProgressMode && slackProgressStyle === "card";
  const explicitProgressTitle = resolveExplicitSlackProgressTitle(account.config);
  const progressDraftMaxLineChars = resolveChannelProgressDraftMaxLineChars(account.config);
  const progressCard = createSlackDraftProgressCardRuntime({
    setup,
    draftStream,
    enabled: useDraftProgressCard,
    detailed: previewToolProgressEnabled,
    progressWorkCounter: previewToolProgressEnabled ? progressWorkCounter : undefined,
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

  const appendNativeProgressCompletion = async (isError: boolean) => {
    const session = delivery.streamSession;
    if (isError) {
      nativeProgressTerminalStatus = "error";
    }
    if (!session || nativeProgressCompletionSent) {
      return;
    }
    const chunks = buildNativeProgressCompletionChunks(isError ? "error" : "complete");
    const narrationUpdate = resolveNarrationUpdate(
      resolveNativeProgressNarration(progressDraft.getSnapshot()),
    );
    if (!chunks?.length && !narrationUpdate.delta) {
      return;
    }
    try {
      await appendSlackStream({ session, chunks });
      if (narrationUpdate.next.changed) {
        nativeNarration = narrationUpdate.next;
      }
      nativeProgressCompletionSent = true;
      delivery.observedReplyDelivery ||= session.delivered;
    } catch (err) {
      delivery.streamFailed = true;
      runtime.error?.(
        danger(`slack-stream: native progress completion failed: ${formatSlackError(err)}`),
      );
    }
  };

  const resolveNativeProgressTitle = (snapshot: ChannelProgressDraftCompositorSnapshot) =>
    combineProgressHeadlineAndExplanation(
      explicitProgressTitle ?? snapshot.statusHeadline,
      snapshot.planExplanation,
    );

  const resolveNarrationUpdate = (incoming: string | undefined) => {
    const next = applyAppendOnlyStreamUpdate({
      incoming: incoming ?? "",
      ...nativeNarration,
    });
    return {
      next,
      delta: next.changed ? next.rendered.slice(nativeNarration.rendered.length) : "",
    };
  };

  const updateNativeProgressStreamNow = async (): Promise<boolean> => {
    if (!useNativeProgressStreaming || delivery.streamFailed || nativeUpdatesStopped) {
      return false;
    }
    const canContinue = await nativeTransport.waitForStart();
    if (!canContinue) {
      return false;
    }
    await delivery.rotateInterruptedStream();
    if (nativeSnapshotSession !== delivery.streamSession) {
      // Task IDs belong to the stream that rendered them, even when another
      // delivery path consumed the interruption before this progress update.
      nativeStreamSnapshot = EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT;
    }
    const snapshot = progressDraft.getSnapshot();
    const narrationUpdate = resolveNarrationUpdate(resolveNativeProgressNarration(snapshot));
    const reconciled = reconcileSlackNativeTaskChunks({
      previous: nativeStreamSnapshot,
      chunks: buildSlackProgressStreamChunks({
        title: resolveNativeProgressTitle(snapshot),
        lines: resolveNativeProgressLines(snapshot),
        plan: snapshot.plan,
        maxLineChars: progressDraftMaxLineChars,
        summaryRow: !previewToolProgressEnabled,
      }),
    });
    const chunks = reconciled.chunks;
    if (!chunks?.length && !narrationUpdate.delta) {
      return false;
    }
    try {
      const hadSession = Boolean(delivery.streamSession);
      const retainedThreadTs = delivery.interruptedThreadTs;
      const streamUpdate = {
        ...(narrationUpdate.delta ? { text: narrationUpdate.delta } : {}),
        ...(chunks?.length ? { chunks } : {}),
      };
      const accepted = hadSession
        ? await nativeTransport.append(streamUpdate)
        : await nativeTransport.start(streamUpdate, retainedThreadTs);
      if (accepted === "rotated") {
        return await updateNativeProgressStreamNow();
      }
      if (!accepted) {
        return false;
      }
      // Commit transport identity and task state together. Buffered or failed
      // chunks must leave the identical render eligible for another attempt.
      if (!hadSession && !retainedThreadTs) {
        replyPlan.markSent();
      }
      nativeSnapshotSession = delivery.streamSession;
      if (narrationUpdate.next.changed) {
        nativeNarration = narrationUpdate.next;
      }
      if (chunks?.length) {
        nativeStreamSnapshot = reconciled.snapshot;
      }
      return true;
    } catch (err) {
      runtime.error?.(
        danger(
          `slack-stream: native progress stream failed: ${formatSlackError(err)}, falling back`,
        ),
      );
      delivery.streamFailed = true;
      return false;
    }
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
    sendOrEditStreamMessage: () => withNativeStreamOrder(updateNativeProgressStreamNow),
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
  ): Promise<LivePreviewDeliveryResult> =>
    withNativeStreamOrder(async () => {
      // The same preamble reaches us as a reply payload and as the compositor
      // headline behind the card title. The card updates it in place, so
      // streaming it as text too would print the line twice.
      if (
        isSlackProgressTitleText(payload.text, progressDraft.getSnapshot(), explicitProgressTitle)
      ) {
        return { visibleReplySent: false };
      }
      const narrationUpdate = resolveNarrationUpdate(payload.text?.trimEnd());
      if (!narrationUpdate.delta) {
        return { visibleReplySent: false };
      }
      const result = await delivery.deliverWithStreaming({
        payload,
        kind,
        streamText: narrationUpdate.delta,
        appendSeparator: false,
        taskDisplayMode: "plan",
      });
      if (result.visibleReplySent && !delivery.streamFailed) {
        nativeNarration = narrationUpdate.next;
      }
      return result;
    });

  const resetProgressTurnState = () => {
    progressWorkCounter.reset();
    cardPostRequested = false;
    nativeNarration = { rendered: "", source: "" };
  };

  const progressDraft = createChannelProgressDraftCompositor({
    preparedItems: true,
    entry: account.config,
    mode: slackStreaming.mode,
    active: progressDraftActive,
    seed: progressSeed,
    formatLine: formatSlackProgressDraftLine,
    reasoningLinePrefix: "🧠 ",
    reasoningGate: !preambleOnlyProgress,
    // A completed preamble may have the same text as its final delta. Its
    // completion still has to reach the transport after a human boundary.
    updateOnLineChange: useNativeProgressStreaming || useDraftProgressCard || preambleOnlyProgress,
    update: async (previewText, options) => {
      if (useNativeProgressStreaming) {
        const priorSnapshot = nativeStreamSnapshot;
        const priorNarration = nativeNarration.rendered;
        nativeUpdates.update(true);
        if (options?.flush) {
          await nativeUpdates.flush();
        } else {
          await nativeUpdates.waitForInFlight();
        }
        return (
          priorSnapshot !== nativeStreamSnapshot || priorNarration !== nativeNarration.rendered
        );
      }
      if (!draftStream) {
        return false;
      }
      const snapshot = options.snapshot;
      const latestLine = snapshot.lines.at(-1);
      if (preambleOnlyProgress && typeof latestLine === "object" && latestLine.complete === false) {
        // Keep the last complete preamble visible. A human reply can rotate this
        // draft between deltas, leaving a word fragment visible until cleanup.
        return false;
      }
      const cardBlocks = useDraftProgressCard
        ? progressCard.resolvePresentation(snapshot, "working")
        : undefined;
      if (cardBlocks?.length === 0) {
        // Hidden state (e.g. a plan in the default card) can outlive the last visible
        // row; delete the card rather than leave a resolved approval on screen.
        if (cardPostRequested || draftStream.messageId()) {
          cardPostRequested = false;
          await draftStream.clear();
          draftStream.forceNewMessage();
        }
        return false;
      }
      draftStream.update(
        preambleOnlyProgress
          ? {
              text: previewText,
              allowNewMessage: typeof latestLine !== "object" || latestLine.complete !== false,
              ...(snapshot.preparedBlocks
                ? { blocks: buildSlackProgressTextBlocks(snapshot.preparedBlocks) }
                : {}),
            }
          : cardBlocks
            ? {
                text: progressCard.resolveCardText(cardBlocks),
                blocks: cardBlocks,
              }
            : snapshot.preparedBlocks
              ? { text: previewText, blocks: buildSlackProgressTextBlocks(snapshot.preparedBlocks) }
              : previewText,
      );
      if (cardBlocks) {
        cardPostRequested = true;
      }
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
        cardPostRequested = false;
        await draftStream?.clear();
        draftStream?.forceNewMessage();
      }
    },
  });
  const previewLifecycle = createLivePreviewLifecycle<
    ReplyPayload,
    { channelId: string; messageId: string }
  >({
    // Native streams and persistent cards have their own terminal operations,
    // not temporary-preview deletion semantics.
    draft:
      draftStream && !useDraftProgressCard
        ? {
            flush: draftStream.flush,
            discardPending: draftStream.discardPending,
            seal: draftStream.seal,
            id: () => {
              const channelId = draftStream.channelId();
              const messageId = draftStream.messageId();
              return channelId && messageId ? { channelId, messageId } : undefined;
            },
            clear: async (): Promise<void> => {
              await draftStream.clear({
                preserveHumanReplies: !isProgressMode && previewLifecycle.finalDelivered,
              });
            },
          }
        : undefined,
    cleanupUndelivered: true,
    onFinalStarted: () => progressDraft.markFinalReplyStarted(),
    onFinalDelivered: () => progressDraft.markFinalReplyDelivered(),
    onCleanupFailure: (error) =>
      logVerbose(`slack: progress preview cleanup failed (${formatSlackError(error)})`),
  });
  const commentaryProgressEnabled = progressDraft.commentaryProgressEnabled;

  const deliverNativeFinal = async (
    payload: ReplyPayload,
    kind: ReplyDispatchKind,
  ): Promise<LivePreviewDeliveryResult> => {
    await cancelNativeUpdates();
    return await withNativeStreamOrder(() => deliverNativeFinalNow(payload, kind));
  };

  const deliverNativeFinalNow = async (payload: ReplyPayload, kind: ReplyDispatchKind) => {
    const streamReady = await nativeTransport.waitForStart();
    await delivery.rotateInterruptedStream();
    const finalThreadTs = delivery.nativeFinalThreadTs();
    // Optional progress may still be buffered locally. Join its stream so
    // final delivery cannot leave a second message to be flushed by stop.
    const canFinishInStream = delivery.canFinishNativeFinal(payload, streamReady);
    if (canFinishInStream) {
      // Flush the terminal task row before buffering the answer so Slack
      // preserves narration -> plan -> final answer ordering.
      await appendNativeProgressCompletion(false);
      return await delivery.deliverWithStreaming({ payload, kind });
    }
    const result = await delivery.deliverNormally({
      payload,
      kind,
      forcedThreadTs: finalThreadTs,
    });
    await appendNativeProgressCompletion(payload.isError === true);
    return result;
  };

  const buildNativeProgressCompletionChunks = (finalInProgressStatus: "complete" | "error") => {
    const snapshot = progressDraft.getSnapshot();
    const lines = resolveNativeProgressLines(snapshot);
    const sessionLinks = progressCard.resolveSessionLinks();
    const narrationUpdate = resolveNarrationUpdate(resolveNativeProgressNarration(snapshot));
    const hasRetirableNativeTasks = [...nativeStreamSnapshot.tasks.values()].some(
      (task) => task.status !== "complete" && task.status !== "error",
    );
    if (
      lines.length === 0 &&
      !snapshot.plan?.length &&
      !hasRetirableNativeTasks &&
      !snapshot.diffStat &&
      !narrationUpdate.delta &&
      sessionLinks.length === 0
    ) {
      return undefined;
    }
    const completion = reconcileSlackNativeTaskChunks({
      previous: nativeStreamSnapshot,
      finalStatus: finalInProgressStatus,
      chunks: buildSlackProgressStreamChunks({
        title: resolveNativeProgressTitle(snapshot),
        lines,
        plan: snapshot.plan,
        maxLineChars: progressDraftMaxLineChars,
        summaryRow: !previewToolProgressEnabled,
        finalInProgressStatus,
        diffStat: snapshot.diffStat,
        sessionLinks,
      }),
    }).chunks;
    // Terminal appends, silent closeout, and queued rotation share this
    // snapshot: authored text still in the batch must reach the SDK before stop.
    return narrationUpdate.delta
      ? [{ type: "markdown_text" as const, text: narrationUpdate.delta }, ...(completion ?? [])]
      : completion;
  };

  const finishNativeProgressTurn = async (
    completionChunks: ReturnType<typeof buildNativeProgressCompletionChunks>,
  ) => {
    if (delivery.nativeProgressStreamStartPromise) {
      await delivery.nativeProgressStreamStartPromise.catch(() => null);
    }
    if (completionChunks?.length) {
      nativeProgressCompletionSent = true;
    }
    await delivery.finishStream(completionChunks);
    delivery.streamSession = null;
    delivery.nativeProgressStreamStartPromise = null;
    delivery.nativeProgressStreamThreadTs = undefined;
    delivery.streamFailed = false;
  };

  const pushPlanProgress = async (
    steps?: AgentPlanStep[],
    explanation?: string,
    explanationFormat?: "plain",
  ) => {
    if (isProgressMode && slackProgressStyle === "compact") {
      return false;
    }
    return await progressDraft.pushPlanProgress(steps, { explanation, explanationFormat });
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
        ...appendState,
      });
      appendState = next;
      if (!next.changed) {
        return false;
      }
      draftStream?.update(next.rendered);
      return false;
    }

    if (isProgressMode) {
      return false;
    }

    progressDraft.resetActivity({ suppressed: true });
    draftStream?.update(trimmed);
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
    return await progressDraft.pushReasoningProgress(payload.text, {
      snapshot: payload.isReasoningSnapshot === true,
    });
  };
  const resetDraftDeliveryState = () => {
    appendState = { rendered: "", source: "" };
  };
  const beginNewProgressTurn = async (options?: { force?: boolean }) => {
    if (useNativeProgressStreaming) {
      if (!nativeUpdatesStopped && options?.force !== true) {
        return false;
      }
      await cancelNativeUpdates();
    }
    const priorSnapshot = progressDraft.getSnapshot();
    const completionChunks =
      useNativeProgressStreaming && !nativeProgressCompletionSent
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
      await progressCard.finalize("success", { snapshot: priorSnapshot });
      await previewLifecycle.cleanup();
      draftStream?.forceNewMessage();
      await dropDetachedProgressCards();
    }
    resetProgressTurnState();
    nativeStreamSnapshot = EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT;
    nativeProgressCompletionSent = false;
    nativeProgressTerminalStatus = "complete";
    nativeUpdatesStopped = false;
    nativeUpdates.resetThrottleWindow();
    progressCard.reset();
    // A re-armed turn is a new visible reply: it must not dedupe against or
    // inherit delivery state from the settled turn (mirrors queued admission).
    previewLifecycle.reset();
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
          // Model boundaries do not accept a provisional preview as a reply.
          // Keep editing it; the draft owner rotates separately when a human speaks.
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
          if (isProgressMode) {
            await beginNewProgressTurn({ force: true });
          } else {
            await previewLifecycle.cleanup();
            previewLifecycle.reset();
            draftStream?.forceNewMessage();
          }
          delivery.resetDeliveryTracker();
          resetDraftDeliveryState();
          progressDraft.reset();
        };
  // A queued turn can drain after its dispatch returned, so dispatch closeout is
  // no longer available to settle its temporary presentation.
  const onQueuedFollowupSettled =
    !draftStream && !useNativeProgressStreaming
      ? undefined
      : async () => {
          if (useNativeProgressStreaming) {
            progressDraft.markFinalReplyStarted();
            await cancelNativeUpdates();
            await finishNativeProgressTurn(
              nativeProgressCompletionSent
                ? undefined
                : buildNativeProgressCompletionChunks(nativeProgressTerminalStatus),
            );
            return;
          }
          if (!useDraftProgressCard) {
            progressDraft.markFinalReplyStarted();
            await previewLifecycle.cleanup();
            return;
          }
          if (!progressCard.hasTerminalized) {
            await draftStream?.clear();
          }
          await dropDetachedProgressCards();
        };

  return {
    draftStream,
    previewLifecycle,
    isProgressMode,
    useDraftProgressCard,
    useNativeProgressStreaming,
    progressDraftActive,
    preambleOnlyProgress,
    suppressDefaultToolProgressMessages,
    progressDraft,
    progressWorkCounter,
    commentaryProgressEnabled,
    async cancel() {
      progressDraft.cancel();
      await cancelNativeUpdates();
    },
    get nativeProgressCompletionSent() {
      return nativeProgressCompletionSent;
    },
    set nativeProgressCompletionSent(value: boolean) {
      nativeProgressCompletionSent = value;
    },
    get nativeProgressTerminalStatus() {
      return nativeProgressTerminalStatus;
    },
    appendNativeNarration,
    buildNativeProgressCompletionChunks,
    deliverNativeFinal,
    dropDetachedProgressCards,
    finalizeDraftProgressCard: progressCard.finalize,
    onVisibleWorkSessions: progressCard.onVisibleWorkSessions,
    onDraftBoundary,
    onQueuedFollowupAdmitted,
    onQueuedFollowupSettled,
    pushPlanProgress,
    pushReasoningProgress,
    updateDraftFromPartial,
  };
}

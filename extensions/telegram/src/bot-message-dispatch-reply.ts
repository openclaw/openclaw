import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import type {
  LivePreviewDeliveryResult,
  OutboundPayloadPlan,
} from "openclaw/plugin-sdk/channel-outbound";
import { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import {
  isFastModeAutoProgressPayload,
  isReplyPayloadNonTerminalToolErrorWarning,
  resolveAskUserQuestionOptionIndices,
  resolveSendableOutboundReplyParts,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramBotDeps } from "./bot-deps.js";
import {
  deliverFinalAnswerText,
  handlePreviewFinalizedResult,
  observeFinalDelivery,
  registerTelegramQuestionDeliveryForMessage,
  sendPayload,
} from "./bot-message-dispatch-delivery.js";
import {
  dropQueuedAnswerBlockRotation,
  enqueueDraftEvent,
  isQueuedAnswerBlock,
  prepareAnswerLaneForText,
  prepareAnswerLaneForToolProgress,
  resetLaneState,
  rotateAnswerLaneForNewMessage,
  splitTextIntoLaneSegments,
  takeQueuedAnswerBlockRotation,
  waitForDraftEvents,
} from "./bot-message-dispatch-draft.js";
import {
  applyTextToPayload,
  normalizeDeliveryPayload,
  normalizePreparedDeliveryPayload,
  formatTelegramGroupThreadReply,
} from "./bot-message-dispatch-payload.js";
import { pushToolProgress } from "./bot-message-dispatch-progress.js";
import { deduplicateBlockSentMedia, trackBlockMedia } from "./bot-message-dispatch.media-dedup.js";
import type {
  TelegramDispatchTurn as Turn,
  TelegramReplyStateSlice,
} from "./bot-message-dispatch.types.js";
import {
  appendTelegramDroppedControlFallback,
  resolveTelegramInlineButtons,
  type TelegramDroppedControl,
  type TelegramInlineButtons,
} from "./button-types.js";
import {
  buildTelegramErrorScopeKey,
  isSilentErrorPolicy,
  resolveTelegramErrorPolicy,
  shouldSuppressTelegramError,
} from "./error-policy.js";
import { shouldSuppressLocalTelegramExecApprovalPrompt } from "./exec-approvals.js";
import { markTelegramDroppedControlFallback } from "./interactive-fallback.js";
import { createTelegramReasoningStepState } from "./reasoning-lane-coordinator.js";
import { resolveTelegramTargetChatType } from "./targets.js";

type BufferedDispatchParams = Parameters<
  TelegramBotDeps["dispatchReplyWithBufferedBlockDispatcher"]
>[0];
type DispatcherOptions = BufferedDispatchParams["dispatcherOptions"];
type Deliver = DispatcherOptions["deliver"];
type Skip = NonNullable<DispatcherOptions["onSkip"]>;
type ErrorCallback = NonNullable<DispatcherOptions["onError"]>;

function toTelegramReplyDeliveryResult(
  turn: Turn,
  visibleReplySent: boolean,
  finalization?: Promise<LivePreviewDeliveryResult>,
  deliveryResult?: LivePreviewDeliveryResult,
): LivePreviewDeliveryResult {
  if (deliveryResult) {
    return {
      ...deliveryResult,
      visibleReplySent: visibleReplySent || deliveryResult.visibleReplySent,
      ...(finalization ? { finalization } : {}),
    };
  }
  if (finalization) {
    return { visibleReplySent, finalization };
  }
  return visibleReplySent
    ? { visibleReplySent: true }
    : {
        visibleReplySent: false,
        suppression: {
          reason: turn.previewLifecycle.finalSuppressed ? "channel_transform" : "no_visible_result",
        },
      };
}

function toTelegramVisiblePartialDeliveryError(error: unknown): unknown {
  return isChannelPartialDeliveryError(error)
    ? error
    : createChannelPartialDeliveryError(error, { visibleReplySent: true });
}

function resolvePayloadTelegramControls(
  turn: Turn,
  payload: ReplyPayload,
): { payload: ReplyPayload; buttons: TelegramInlineButtons | undefined } {
  const telegramData = payload.channelData?.telegram as
    | { buttons?: TelegramInlineButtons }
    | undefined;
  const droppedControls: TelegramDroppedControl[] = [];
  const buttons = resolveTelegramInlineButtons(
    {
      buttons: telegramData?.buttons,
      presentation: normalizeMessagePresentation(payload.presentation),
      interactive: payload.interactive,
    },
    {
      allowWebAppButtons: resolveTelegramTargetChatType(String(turn.context.chatId)) === "direct",
      onDroppedControl: (control) => droppedControls.push(control),
      questionOptionIndices: resolveAskUserQuestionOptionIndices(payload),
    },
  );
  const text = appendTelegramDroppedControlFallback(payload.text ?? "", droppedControls);
  const fallback = appendTelegramDroppedControlFallback("", droppedControls);
  const normalizedPayload =
    text === (payload.text ?? "") ? payload : applyTextToPayload(payload, text);
  return {
    payload: fallback
      ? markTelegramDroppedControlFallback(
          normalizedPayload,
          text === fallback ? "" : text.slice(0, -fallback.length - 2),
          text,
        )
      : normalizedPayload,
    buttons,
  };
}
function hasExecApprovalPayload(payload: ReplyPayload): boolean {
  return payload.channelData?.execApproval !== undefined;
}

export function createReplyState(): TelegramReplyStateSlice {
  return {
    reasoningStepState: createTelegramReasoningStepState(),
    bufferedFinalSettlement: undefined,
    sentBlockMediaUrls: new Set<string>(),
    splitReasoningOnNextStream: false,
  };
}

function settleBufferedFinalAsNotVisible(turn: Turn): void {
  if (turn.bufferedFinalSettlement) {
    turn.bufferedFinalSettlement.resolve({
      visibleReplySent: turn.bufferedFinalSettlement.visibleReplySent,
    });
  }
  turn.bufferedFinalSettlement = undefined;
}

export function resetReasoningStepState(turn: Turn): void {
  settleBufferedFinalAsNotVisible(turn);
  turn.reasoningStepState.resetForNextStep();
}

async function flushBufferedFinalAnswer(turn: Turn, currentPayloadVisible = false): Promise<void> {
  const settlement = turn.bufferedFinalSettlement;
  const buffered = turn.reasoningStepState.takeBufferedFinalAnswer();
  turn.bufferedFinalSettlement = undefined;
  if (!buffered) {
    settlement?.resolve({ visibleReplySent: settlement.visibleReplySent });
    turn.reasoningStepState.resetForNextStep();
    return;
  }
  try {
    const controls = resolvePayloadTelegramControls(turn, buffered);
    const result = await deliverFinalAnswerText(
      turn,
      controls.payload,
      controls.payload.text ?? "",
      controls.buttons,
      settlement?.onPlatformSendDispatch,
      settlement?.assertPlatformSendAuthorized,
      settlement?.bindPendingFinalDelivery,
    );
    if (settlement) {
      settlement.resolve({
        ...result.deliveryResult,
        visibleReplySent: settlement.visibleReplySent || result.deliveryResult.visibleReplySent,
      });
    }
    resetReasoningStepState(turn);
  } catch (error: unknown) {
    if (settlement) {
      settlement.reject(
        settlement.visibleReplySent ? toTelegramVisiblePartialDeliveryError(error) : error,
      );
    }
    throw currentPayloadVisible ? toTelegramVisiblePartialDeliveryError(error) : error;
  }
}

async function stopTelegramReplyLanesAndFlushBufferedFinal(turn: Turn): Promise<void> {
  await turn.answerLane.stream?.stop();
  await turn.reasoningLane.stream?.stop();
  // Both lanes must stop before the buffered flush, keeping the final answer the last visible send.
  await flushBufferedFinalAnswer(turn);
}

async function settleTerminalNoVisibleDelivery(
  turn: Turn,
  info: Parameters<NonNullable<Deliver>>[1],
  options?: { abandonBufferedFinal?: boolean },
): Promise<LivePreviewDeliveryResult> {
  if (options?.abandonBufferedFinal) {
    resetReasoningStepState(turn);
  } else if (info.kind === "final") {
    // A terminal callback must drain the buffered answer before the next step can reset it.
    await flushBufferedFinalAnswer(turn);
  }
  return toTelegramReplyDeliveryResult(turn, false);
}

async function adoptProgressContinuation(
  turn: Turn,
  payload: ReplyPayload,
  info: Parameters<NonNullable<Deliver>>[1],
): Promise<boolean> {
  if (
    info.kind !== "final" ||
    payload.isError === true ||
    typeof info.adoptProgressContinuation !== "function"
  ) {
    return false;
  }
  const adopt = info.adoptProgressContinuation;
  await waitForDraftEvents(turn);
  const stream = turn.answerLane.stream;
  if (!stream || turn.answerLane.finalized || turn.isSuperseded()) {
    return false;
  }
  if (
    !turn.progressCompositor.isVisible &&
    !turn.progressCompositor.hasStarted &&
    (turn.progressCompositor.hasStatusHeadline ||
      turn.progressCompositor.hasPlanProgress ||
      turn.progressCompositor.getSnapshot().lines.length > 0)
  ) {
    info.assertPlatformSendAuthorized?.();
    await turn.progressCompositor.start();
  }
  if (!turn.progressCompositor.isVisible || turn.isSuperseded()) {
    return false;
  }
  turn.progressCompositor.cancel();
  info.assertPlatformSendAuthorized?.();
  await stream.flush();
  const messageId = stream.messageId();
  const text = stream.lastDeliveredText();
  // Only a confirmed provider receipt can transfer custody, never staged draft intent.
  if (
    typeof messageId !== "number" ||
    !Number.isFinite(messageId) ||
    !text ||
    turn.isSuperseded()
  ) {
    return false;
  }
  info.assertPlatformSendAuthorized?.();
  const adopted = await adopt({
    channel: "telegram",
    accountId: turn.context.route.accountId,
    to: String(turn.context.chatId),
    threadId: turn.context.threadSpec.id,
    messageId: String(messageId),
    text,
    snapshot: turn.progressCompositor.getSnapshot(),
  });
  if (!adopted) {
    return false;
  }
  // Core now owns the visible card. Remove the old transport before any awaited
  // retirement so late callbacks and unconditional cleanup cannot delete it.
  turn.answerLane.stream = undefined;
  turn.progressContinuationAdopted = true;
  resetLaneState(turn, turn.answerLane);
  resetReasoningStepState(turn);
  turn.deliveryState.markDelivered();
  await stream.discard();
  return true;
}
export async function deliverReply(
  turn: Turn,
  payload: Parameters<NonNullable<Deliver>>[0],
  info: Parameters<NonNullable<Deliver>>[1],
): Promise<LivePreviewDeliveryResult> {
  return deliverReplyWithNormalization(turn, payload, info, normalizeDeliveryPayload);
}

export async function deliverPreparedReply(
  turn: Turn,
  plan: OutboundPayloadPlan,
  info: Parameters<NonNullable<Deliver>>[1],
): Promise<LivePreviewDeliveryResult> {
  return deliverReplyWithNormalization(turn, plan.payload, info, normalizePreparedDeliveryPayload);
}

async function deliverReplyWithNormalization(
  turn: Turn,
  incomingPayload: ReplyPayload,
  info: Parameters<NonNullable<Deliver>>[1],
  normalizePayload: typeof normalizeDeliveryPayload,
): Promise<LivePreviewDeliveryResult> {
  if (turn.isSuperseded()) {
    return await settleTerminalNoVisibleDelivery(turn, info, { abandonBufferedFinal: true });
  }
  let payload = incomingPayload;
  if (info.participant && (payload.text || payload.mediaUrl || payload.mediaUrls?.length)) {
    payload = applyTextToPayload(
      payload,
      formatTelegramGroupThreadReply(payload.text ?? "", info.participant),
    );
  }
  const normalizedPayload = normalizePayload(turn, payload);
  if (!normalizedPayload) {
    return await settleTerminalNoVisibleDelivery(turn, info);
  }
  const deduped =
    info.kind === "final"
      ? deduplicateBlockSentMedia(normalizedPayload, turn.sentBlockMediaUrls)
      : normalizedPayload;
  if (!deduped) {
    return await settleTerminalNoVisibleDelivery(turn, info);
  }
  const controls = resolvePayloadTelegramControls(turn, deduped);
  const effectivePayload = controls.payload;
  const onMediaAccepted =
    info.kind === "block"
      ? (mediaUrls: readonly string[]) =>
          trackBlockMedia(turn.sentBlockMediaUrls, effectivePayload, mediaUrls)
      : undefined;
  if (
    shouldSuppressLocalTelegramExecApprovalPrompt({
      cfg: turn.cfg,
      accountId: turn.context.route.accountId,
      payload: effectivePayload,
    })
  ) {
    turn.suppressSilentReplyFallback = true;
    return await settleTerminalNoVisibleDelivery(turn, info);
  }
  const telegramButtons = controls.buttons;
  const reply = resolveSendableOutboundReplyParts(effectivePayload);
  if (
    !reply.hasMedia &&
    telegramButtons === undefined &&
    effectivePayload.interactive === undefined &&
    effectivePayload.presentation === undefined &&
    effectivePayload.channelData?.askUser === undefined &&
    !hasExecApprovalPayload(effectivePayload) &&
    (await adoptProgressContinuation(turn, incomingPayload, info))
  ) {
    return toTelegramReplyDeliveryResult(turn, true);
  }
  const lanePayload =
    info.kind === "block" &&
    typeof payload.text === "string" &&
    typeof effectivePayload.text === "string" &&
    payload.text !== effectivePayload.text &&
    payload.text.trimEnd() === effectivePayload.text &&
    !effectivePayload.mediaUrl &&
    !effectivePayload.mediaUrls?.length
      ? applyTextToPayload(effectivePayload, payload.text)
      : effectivePayload;
  const split = splitTextIntoLaneSegments(turn, { text: lanePayload.text }, payload.isReasoning);
  const segments = split.segments;
  if (info.kind === "final" && (reply.text.length > 0 || reply.hasMedia)) {
    // Mark final delivery before any queued draft drain; late tool progress must stay suppressed.
    turn.previewLifecycle.beginFinalDelivery();
  }
  if (info.kind === "final") {
    // Final delivery drains queued draft work so an earlier block cannot overtake it.
    await enqueueDraftEvent(turn, async () => {});
  }
  const isToolPayloadAfterFinal = info.kind === "tool" && turn.previewLifecycle.finalStarted;
  const isNonTerminalWarningAfterDeliveredFinal =
    isReplyPayloadNonTerminalToolErrorWarning(payload) && turn.previewLifecycle.finalDelivered;
  if (
    (isToolPayloadAfterFinal || isNonTerminalWarningAfterDeliveredFinal) &&
    !reply.hasMedia &&
    !hasExecApprovalPayload(effectivePayload)
  ) {
    return await settleTerminalNoVisibleDelivery(turn, info);
  }
  if (payload.isError === true) {
    turn.hadErrorReplyFailureOrSkip = true;
  }

  let blockDelivered = false;
  let finalization: Promise<LivePreviewDeliveryResult> | undefined;
  let finalDeliveryResult: LivePreviewDeliveryResult | undefined;
  const hasAnswerSegment = segments.some((segment) => segment.lane === "answer");
  if (info.kind === "block" && !hasAnswerSegment) {
    dropQueuedAnswerBlockRotation(turn, effectivePayload, info.assistantMessageIndex);
  }
  for (const segment of segments) {
    if (
      segment.lane === "answer" &&
      info.kind === "final" &&
      turn.reasoningStepState.shouldBufferFinalAnswer()
    ) {
      let resolveFinalization!: (result: LivePreviewDeliveryResult) => void;
      let rejectFinalization!: (error: unknown) => void;
      finalization = new Promise((resolve, reject) => {
        resolveFinalization = resolve;
        rejectFinalization = reject;
      });
      // The coordinator admits only one buffered answer. Settle defensively before replacing
      // its paired promise so an unexpected rebuffer can never orphan turn finalization.
      settleBufferedFinalAsNotVisible(turn);
      turn.bufferedFinalSettlement = {
        visibleReplySent: blockDelivered,
        onPlatformSendDispatch: info.onPlatformSendDispatch,
        assertPlatformSendAuthorized: info.assertPlatformSendAuthorized,
        bindPendingFinalDelivery: info.bindPendingFinalDelivery,
        resolve: resolveFinalization,
        reject: rejectFinalization,
      };
      turn.reasoningStepState.bufferFinalAnswer(
        applyTextToPayload(effectivePayload, segment.update.text),
      );
      continue;
    }
    if (segment.lane === "reasoning") {
      turn.reasoningStepState.noteReasoningHint();
    }
    if (segment.lane === "answer" && info.kind === "tool") {
      if (turn.verboseProgressActive()) {
        const delivery = await sendPayload(
          turn,
          applyTextToPayload(effectivePayload, segment.update.text),
        );
        if (delivery.visibleReplySent) {
          blockDelivered = true;
        }
        continue;
      }
      const canRepresentAsTransientProgress =
        !reply.hasMedia &&
        telegramButtons === undefined &&
        effectivePayload.channelData?.askUser === undefined &&
        !hasExecApprovalPayload(effectivePayload);
      const isFastModeProgressPayload = isFastModeAutoProgressPayload(effectivePayload);
      if (turn.streamMode === "progress") {
        if (
          canRepresentAsTransientProgress &&
          turn.answerLane.stream &&
          !isFastModeProgressPayload
        ) {
          continue;
        }
        if (
          (canRepresentAsTransientProgress || isFastModeProgressPayload) &&
          (await pushToolProgress(turn, segment.update.text, {
            startImmediately: true,
          }))
        ) {
          blockDelivered = true;
          continue;
        }
      }
      await prepareAnswerLaneForToolProgress(turn);
    }

    const ownedByQueuedRotation = isQueuedAnswerBlock(
      turn,
      lanePayload,
      info.assistantMessageIndex,
    );
    const skipTextOnlyBlock =
      turn.streamMode === "partial" &&
      info.kind === "block" &&
      segment.lane === "answer" &&
      !reply.hasMedia &&
      !hasExecApprovalPayload(effectivePayload) &&
      telegramButtons === undefined &&
      turn.answerLane.hasStreamedMessage &&
      !turn.activeAnswerDraftIsToolProgressOnly &&
      !ownedByQueuedRotation &&
      segment.update.text.trimEnd() === turn.answerLane.lastPartialText.trimEnd();
    const suppressProgressAnswerBlock =
      turn.streamMode === "progress" &&
      info.kind === "block" &&
      segment.lane === "answer" &&
      !reply.hasMedia &&
      !hasExecApprovalPayload(effectivePayload) &&
      telegramButtons === undefined;
    if (skipTextOnlyBlock || suppressProgressAnswerBlock) {
      turn.activeAnswerBlockDelivery = {
        payload: effectivePayload,
        text: segment.update.text,
        buttons: telegramButtons,
      };
      turn.activeAnswerDraftIsToolProgressOnly = false;
      if (!suppressProgressAnswerBlock) {
        turn.progressCompositor.resetActivity();
      }
      blockDelivered = true;
      continue;
    }

    if (segment.lane === "answer" && info.kind === "block") {
      const prepared = await prepareAnswerLaneForText(turn);
      const shouldRotate = takeQueuedAnswerBlockRotation(
        turn,
        lanePayload,
        info.assistantMessageIndex,
      );
      if (turn.streamMode !== "progress" && shouldRotate && !prepared) {
        await rotateAnswerLaneForNewMessage(turn);
        turn.rotateAnswerLaneWhenQueuedBlocksSettle = false;
      }
      turn.activeAnswerDraftIsToolProgressOnly = false;
      turn.progressCompositor.resetActivity();
    }
    const isAskUserPayload = effectivePayload.channelData?.askUser !== undefined;
    const result =
      segment.lane === "answer" && info.kind === "final"
        ? await deliverFinalAnswerText(
            turn,
            effectivePayload,
            segment.update.text,
            telegramButtons,
            info.onPlatformSendDispatch,
            info.assertPlatformSendAuthorized,
            info.bindPendingFinalDelivery,
          )
        : await turn.deliverLaneText({
            laneName: segment.lane,
            text: segment.update.text,
            payload: lanePayload,
            infoKind: info.kind,
            buttons: telegramButtons,
            ...(isAskUserPayload ? { finalizePreview: true } : {}),
            onPlatformSendDispatch: info.onPlatformSendDispatch,
            assertPlatformSendAuthorized: info.assertPlatformSendAuthorized,
            bindPendingFinalDelivery: info.bindPendingFinalDelivery,
            onMediaAccepted,
          });
    const finalizedPreview =
      segment.lane === "answer" &&
      info.kind !== "final" &&
      (result.kind === "preview-finalized" || result.kind === "preview-finalized-partial");
    if (finalizedPreview) {
      await handlePreviewFinalizedResult(turn, result);
      if (isAskUserPayload && result.kind === "preview-finalized") {
        registerTelegramQuestionDeliveryForMessage(turn, effectivePayload, {
          messageId: result.delivery.messageId,
          text: result.delivery.content,
        });
      }
    }
    if (segment.lane === "answer" && info.kind === "block" && result.kind === "preview-updated") {
      turn.activeAnswerBlockDelivery = {
        payload: lanePayload,
        text: segment.update.text,
        buttons: telegramButtons,
      };
    }
    blockDelivered ||= result.deliveryResult.visibleReplySent;
    if (info.kind === "final" && segment.lane === "answer") {
      finalDeliveryResult = result.deliveryResult;
    }
    if (segment.lane === "reasoning") {
      if (result.deliveryResult.visibleReplySent) {
        turn.reasoningStepState.noteReasoningDelivered();
        if (finalization && turn.bufferedFinalSettlement) {
          turn.bufferedFinalSettlement.visibleReplySent ||= blockDelivered;
        }
        await flushBufferedFinalAnswer(turn, blockDelivered);
      }
    } else if (info.kind === "final") {
      resetReasoningStepState(turn);
    }
  }
  if (segments.length > 0) {
    if (finalization && turn.bufferedFinalSettlement) {
      turn.bufferedFinalSettlement.visibleReplySent ||= blockDelivered;
    }
    return toTelegramReplyDeliveryResult(turn, blockDelivered, finalization, finalDeliveryResult);
  }

  if (split.suppressedReasoningOnly) {
    let deliveryResult: LivePreviewDeliveryResult = { visibleReplySent: false };
    if (info.kind === "final") {
      await stopTelegramReplyLanesAndFlushBufferedFinal(turn);
    }
    if (reply.hasMedia) {
      const payloadWithoutReasoning =
        typeof effectivePayload.text === "string"
          ? applyTextToPayload(effectivePayload, "")
          : effectivePayload;
      deliveryResult = await sendPayload(turn, payloadWithoutReasoning, {
        durable: info.kind === "final",
        onPlatformSendDispatch: info.onPlatformSendDispatch,
        assertPlatformSendAuthorized: info.assertPlatformSendAuthorized,
        bindPendingFinalDelivery: info.bindPendingFinalDelivery,
        onMediaAccepted,
      });
    }
    if (info.kind === "final" && reply.hasMedia) {
      await observeFinalDelivery(turn, deliveryResult, effectivePayload.isError === true);
    }
    return toTelegramReplyDeliveryResult(
      turn,
      deliveryResult.visibleReplySent,
      undefined,
      deliveryResult,
    );
  }

  if (info.kind === "final") {
    await stopTelegramReplyLanesAndFlushBufferedFinal(turn);
  }
  if (!reply.hasMedia && reply.text.length === 0) {
    if (info.kind === "final") {
      await flushBufferedFinalAnswer(turn);
    }
    return toTelegramReplyDeliveryResult(turn, false);
  }
  const deliveryResult = await sendPayload(turn, effectivePayload, {
    durable: info.kind === "final",
    onPlatformSendDispatch: info.onPlatformSendDispatch,
    assertPlatformSendAuthorized: info.assertPlatformSendAuthorized,
    bindPendingFinalDelivery: info.bindPendingFinalDelivery,
    onMediaAccepted,
  });
  if (info.kind === "final") {
    await observeFinalDelivery(turn, deliveryResult, effectivePayload.isError === true);
  }
  return toTelegramReplyDeliveryResult(
    turn,
    deliveryResult.visibleReplySent,
    undefined,
    deliveryResult,
  );
}

export function handleReplySkip(
  turn: Turn,
  payload: Parameters<Skip>[0],
  info: Parameters<Skip>[1],
): void {
  if (info.kind === "final" && info.reason === "silent") {
    turn.previewLifecycle.observeSuppression();
  }
  if (info.kind === "block") {
    void enqueueDraftEvent(turn, async () => {
      dropQueuedAnswerBlockRotation(turn, payload, info.assistantMessageIndex);
    });
  }
  if (payload.isError === true) {
    turn.hadErrorReplyFailureOrSkip = true;
  }
  if (info.reason !== "silent") {
    turn.deliveryState.markNonSilentSkip();
  }
}

export function handleReplyError(
  turn: Turn,
  err: Parameters<ErrorCallback>[0],
  info: Parameters<ErrorCallback>[1],
): void {
  if (info.kind === "final") {
    turn.previewLifecycle.observeFailure(
      isChannelPartialDeliveryError(err) ? err.deliveryResult : undefined,
    );
    if (isChannelPartialDeliveryError(err)) {
      turn.deliveryState.markDelivered();
    }
  }
  const errorPolicy = resolveTelegramErrorPolicy({
    accountConfig: turn.telegramCfg,
    groupConfig: turn.context.groupConfig,
    topicConfig: turn.context.topicConfig,
  });
  if (isSilentErrorPolicy(errorPolicy.policy)) {
    return;
  }
  if (
    errorPolicy.policy === "once" &&
    shouldSuppressTelegramError({
      scopeKey: buildTelegramErrorScopeKey({
        accountId: turn.context.route.accountId,
        chatId: turn.context.chatId,
        threadSpec: turn.context.threadSpec,
      }),
      cooldownMs: errorPolicy.cooldownMs,
      errorMessage: String(err),
    })
  ) {
    return;
  }
  turn.deliveryState.markNonSilentFailure();
  turn.runtime.error?.(danger(`telegram ${info.kind} reply failed: ${String(err)}`));
}

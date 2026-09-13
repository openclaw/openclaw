/**
 * Handles assistant message deltas, reasoning, directives, and block replies.
 */
import { createInlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import type { AssistantMessage } from "../llm/types.js";
import { resolveAssistantMessagePhase } from "../shared/chat-message-content.js";
import { downgradedToolCallTextFilter } from "../shared/text/assistant-visible-text.js";
import { createTextProjection, trimTextFilter } from "../shared/text/text-projection.js";
import { resolveCurrentSourceMessagingToolPartial } from "./embedded-agent-helpers/messaging-dedupe.js";
import { updateLiveEditDiffProgress } from "./embedded-agent-live-edit-diff.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import {
  mergeReplyDirectiveResults,
  recordPendingAssistantReplyDirectives,
} from "./embedded-agent-subscribe.handlers.messages.replies.js";
import {
  extractAssistantStreamSnapshot,
  reconcileBlockReplySnapshot,
} from "./embedded-agent-subscribe.handlers.messages.snapshot.js";
import {
  emitAssistantCommentaryStreamData,
  emitAssistantMessageStart,
  emitReasoningEnd,
  hasMessageToolOnlySourceDelivery,
  isAnthropicAssistantMessage,
  isOpenAiCompletionsAssistantMessage,
  isResponsesApiAssistantMessage,
  isSubscribeTranscriptOnlyOpenClawAssistantMessage,
  openReasoningStream,
  resolveAssistantStreamBlockIndex,
  resolveAssistantStreamContentIndex,
  resolveAssistantStreamItemId,
  resolveAssistantTextChunk,
  resolveStreamingReply,
  scopeAssistantMessageToStreamBlock,
  shouldSuppressDeterministicApprovalOutput,
} from "./embedded-agent-subscribe.handlers.messages.stream.js";
import type {
  EmbeddedAgentSubscribeContext,
  EmbeddedAgentSubscribeState,
} from "./embedded-agent-subscribe.handlers.types.js";
import { appendRawStream } from "./embedded-agent-subscribe.raw-stream.js";
import {
  createAssistantVisibleStreamText,
  createThinkingTagStreamState,
  extractAssistantCommentaryText,
  extractAssistantThinking,
  extractAssistantVisibleText,
  extractThinkingFromTaggedStream,
} from "./embedded-agent-utils.js";
import type { AgentEvent, AgentMessage } from "./runtime/index.js";

const REASONING_TAG_RE = /<\s*\/?\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)\b/i;

export function handleMessageUpdate(
  ctx: EmbeddedAgentSubscribeContext,
  evt: AgentEvent & { message: AgentMessage; assistantMessageEvent?: unknown },
): Promise<void> | undefined {
  const msg = evt.message;
  if (msg?.role !== "assistant" || isSubscribeTranscriptOnlyOpenClawAssistantMessage(msg)) {
    return undefined;
  }

  ctx.noteLastAssistant(msg);
  const assistantEvent = evt.assistantMessageEvent;
  const assistantRecord =
    assistantEvent && typeof assistantEvent === "object"
      ? (assistantEvent as Record<string, unknown>)
      : undefined;
  const evtType = typeof assistantRecord?.type === "string" ? assistantRecord.type : "";
  if (evtType !== "text_delta") {
    ctx.flushAssistantStream();
  }
  const liveEditDiff = updateLiveEditDiffProgress(ctx.state.liveEditDiffStateById, assistantRecord);
  if (liveEditDiff) {
    const data = { phase: "input_delta", ...liveEditDiff };
    emitAgentEvent({ runId: ctx.params.runId, stream: "tool", data });
    runBestEffortCallback({
      label: "live edit diff agent event",
      log: ctx.log,
      callback: () => ctx.params.onAgentEvent?.({ stream: "tool", data }),
    });
  }
  const eventAssistantMessage =
    assistantRecord?.partial && typeof assistantRecord.partial === "object"
      ? (assistantRecord.partial as AssistantMessage)
      : msg;
  const isResponsesTextEvent =
    isResponsesApiAssistantMessage(eventAssistantMessage) &&
    (evtType === "text_start" || evtType === "text_delta" || evtType === "text_end");
  const assistantPhase = resolveAssistantMessagePhase(msg);
  const suppressVisibleAssistantOutput = assistantPhase === "commentary";
  if (suppressVisibleAssistantOutput && !isResponsesTextEvent) {
    // Even hidden commentary closes the preceding visible-text scope.
    ctx.flushAssistantStream();
    const commentaryText = extractAssistantCommentaryText(msg);
    if (commentaryText) {
      appendRawStream(() => ({
        ts: Date.now(),
        event: "assistant_text_stream",
        runId: ctx.params.runId,
        sessionId: (ctx.params.session as { id?: string }).id,
        evtType: "commentary_update",
        delta: "",
        content: commentaryText,
      }));
      emitAssistantCommentaryStreamData(ctx, msg, false, commentaryText);
    }
    return undefined;
  }
  const suppressDeterministicApprovalOutput = shouldSuppressDeterministicApprovalOutput(ctx.state);
  const suppressMessageToolOnlySourceReplyOutput = hasMessageToolOnlySourceDelivery(ctx);

  if (evtType === "thinking_start" || evtType === "thinking_delta" || evtType === "thinking_end") {
    if (
      !suppressMessageToolOnlySourceReplyOutput &&
      (evtType === "thinking_start" || evtType === "thinking_delta")
    ) {
      openReasoningStream(ctx);
    }
    const thinkingDelta = typeof assistantRecord?.delta === "string" ? assistantRecord.delta : "";
    const thinkingContent =
      typeof assistantRecord?.content === "string" ? assistantRecord.content : "";
    appendRawStream(() => ({
      ts: Date.now(),
      event: "assistant_thinking_stream",
      runId: ctx.params.runId,
      sessionId: (ctx.params.session as { id?: string }).id,
      evtType,
      delta: thinkingDelta,
      content: thinkingContent,
    }));
    // Emit-always: emitReasoningStream always reaches the bus/archive; the
    // streamReasoning rendering hook and message_tool_only source suppression
    // are gated downstream (dispatch wrapProgressCallback, #92738), so emission
    // here stays unconditional.
    // Prefer full partial-message thinking when available; fall back to event payloads.
    const block =
      Array.isArray(msg.content) && msg.content.length === 1 ? msg.content[0] : undefined;
    const nativeThinking = block?.type === "thinking" ? block : undefined;
    ctx.emitReasoningStream(
      nativeThinking ?? (extractAssistantThinking(msg) || thinkingContent || thinkingDelta),
      nativeThinking ? thinkingContent || thinkingDelta : undefined,
    );
    if (evtType === "thinking_end" && !suppressMessageToolOnlySourceReplyOutput) {
      // Mirror the open gate above: when message-tool-only delivery has made the
      // reasoning lane private, do not force-open it just to close it — that
      // would fire the lane's end hook (onReasoningEnd) for a lane that never
      // rendered, leaking the boundary signal.
      if (!ctx.state.reasoningStreamOpen) {
        openReasoningStream(ctx);
      }
      emitReasoningEnd(ctx);
    }
    return undefined;
  }

  if (evtType !== "text_delta" && evtType !== "text_start" && evtType !== "text_end") {
    return undefined;
  }

  const delta = typeof assistantRecord?.delta === "string" ? assistantRecord.delta : "";
  const content = typeof assistantRecord?.content === "string" ? assistantRecord.content : "";

  appendRawStream(() => ({
    ts: Date.now(),
    event: "assistant_text_stream",
    runId: ctx.params.runId,
    sessionId: (ctx.params.session as { id?: string }).id,
    evtType,
    delta,
    content,
  }));

  const partialAssistant = eventAssistantMessage;
  const priorBlockText = ctx.state.streamBlockText;
  const priorBlockFinal = ctx.state.streamBlockFinal;
  const priorBlockIndex = ctx.state.lastAssistantStreamContentIndex;
  const streamContentIndex = resolveAssistantStreamContentIndex(assistantRecord?.contentIndex);
  const streamItemId = resolveAssistantStreamItemId({
    contentIndex: streamContentIndex,
    message: partialAssistant,
  });
  const blockSourceIndex =
    resolveAssistantStreamBlockIndex(partialAssistant, streamContentIndex, streamItemId) ??
    streamContentIndex;
  const priorSourceIndex =
    resolveAssistantStreamBlockIndex(
      partialAssistant,
      priorBlockIndex,
      ctx.state.lastAssistantStreamItemId,
    ) ?? priorBlockIndex;
  const streamAssistant = scopeAssistantMessageToStreamBlock(
    partialAssistant,
    streamContentIndex,
    streamItemId,
  );
  const deliveryPhase = resolveAssistantMessagePhase(streamAssistant);
  const isPhasePendingResponsesTextItem =
    evtType !== "text_end" &&
    !deliveryPhase &&
    Boolean(streamItemId) &&
    isResponsesApiAssistantMessage(partialAssistant);
  // These transports resolve commentary only at the tool boundary. Withhold
  // early unphased deltas from durable block replies until that decision exists.
  const isPhasePendingAnthropicText =
    evtType !== "text_end" && !deliveryPhase && isAnthropicAssistantMessage(partialAssistant);
  const isCompletionsAssistant = isOpenAiCompletionsAssistantMessage(partialAssistant);
  const isPhasePendingCompletionsText = !deliveryPhase && isCompletionsAssistant;
  const isReasoningCompletionsText =
    isCompletionsAssistant && partialAssistant.openclawDelivery?.textPhaseRequiresTerminal === true;
  const hasResponsesContentIndex =
    streamContentIndex !== undefined && isResponsesApiAssistantMessage(partialAssistant);
  let streamItemChanged = false;
  let deliveryItemId = streamItemId;
  if (
    (deliveryPhase || isPhasePendingResponsesTextItem || hasResponsesContentIndex) &&
    (streamContentIndex !== undefined || streamItemId)
  ) {
    const previousStreamContentIndex = ctx.state.lastAssistantStreamContentIndex;
    const previousStreamItemId = ctx.state.lastAssistantStreamItemId;
    const contentIndexChanged =
      previousStreamContentIndex !== undefined &&
      streamContentIndex !== undefined &&
      previousStreamContentIndex !== streamContentIndex;
    const itemIdChangedWithoutIndexes =
      (previousStreamContentIndex === undefined || streamContentIndex === undefined) &&
      Boolean(previousStreamItemId && streamItemId && previousStreamItemId !== streamItemId);
    if (contentIndexChanged || itemIdChangedWithoutIndexes) {
      streamItemChanged = true;
      void ctx.flushBlockReplyBuffer({ assistantMessageIndex: ctx.state.assistantMessageIndex });
      ctx.resetAssistantMessageState(ctx.state.assistantTexts.length);
      ctx.state.blockReplyScopeStart = {
        contentIndex: streamContentIndex ?? blockSourceIndex ?? 0,
        itemId: streamItemId,
      };
      emitAssistantMessageStart(ctx);
    } else if (
      previousStreamContentIndex !== undefined &&
      streamContentIndex === previousStreamContentIndex &&
      previousStreamItemId
    ) {
      // Snapshot-extension items can rotate provider ids while retaining one logical block.
      // Keep the original live key so downstream commentary accumulators do not split it.
      deliveryItemId = previousStreamItemId;
    }
    ctx.state.lastAssistantStreamItemId = deliveryItemId;
  }
  if (streamContentIndex !== undefined) {
    if (streamContentIndex !== ctx.state.lastAssistantStreamContentIndex) {
      ctx.flushAssistantStream();
      ctx.state.streamBlockText = "";
      ctx.state.streamBlockFinal = false;
    }
    ctx.state.lastAssistantStreamContentIndex = streamContentIndex;
  }
  const chunk = resolveAssistantTextChunk({
    evtType,
    delta,
    content,
    accumulatedText: ctx.state.streamBlockText,
  });
  ctx.state.streamBlockText += chunk;
  ctx.state.streamBlockFinal = evtType === "text_end";
  // Responses text_start snapshots may already contain text replayed by the first delta.
  // Keep starts lifecycle-only so commentary and final-answer lanes consume each byte once.
  if (evtType === "text_start" && isResponsesApiAssistantMessage(partialAssistant)) {
    return undefined;
  }
  if (deliveryPhase === "commentary") {
    if (ctx.state.assistantStream?.projection) {
      ctx.state.assistantStream.projection.directiveCodePrefix = undefined;
    }
    const isResponsesCommentary = isResponsesApiAssistantMessage(partialAssistant);
    const hadResponsesCommentaryText = isResponsesCommentary && Boolean(ctx.state.deltaBuffer);
    if (isResponsesCommentary && chunk) {
      // Keep cumulative end events monotonic without feeding commentary into reply buffers.
      ctx.state.deltaBuffer += chunk;
      ctx.state.deltaBufferIsCommentary = true;
    }
    const commentaryText = isResponsesCommentary
      ? ctx.state.deltaBuffer
      : extractAssistantCommentaryText(streamAssistant);
    if (commentaryText && (chunk || !hadResponsesCommentaryText || evtType === "text_end")) {
      ctx.emitAssistantStreamData(
        {
          text: commentaryText,
          delta: "",
          replace: true,
          phase: "commentary",
          itemId: deliveryItemId,
        },
        { finalMessage: evtType === "text_end" },
      );
    }
    return undefined;
  }
  if (isPhasePendingResponsesTextItem) {
    return undefined;
  }
  // Subagents have no live consumer; their final result is delivered from
  // message_end. Keep accumulating deltaBuffer, but skip per-chunk visible-text
  // parsing so long parallel subagent streams do not monopolize the event loop.
  const skipLiveStream = ctx.params.suppressLiveStreamOutput === true;
  const shouldUsePhaseAwareBlockReply = Boolean(deliveryPhase);
  const reprojectBlockReply =
    shouldUsePhaseAwareBlockReply &&
    !ctx.params.enforceFinalTag &&
    ctx.state.assistantStream?.projection?.kind !== "final" &&
    ctx.blockChunker.consumedLength === 0;
  const finalText = evtType === "text_end";

  // A completions stream cannot classify text interrupted by later reasoning
  // until terminal. Keep that text out of live reply lanes until its phase resolves.
  if (isReasoningCompletionsText) {
    return undefined;
  }

  if (chunk) {
    ctx.state.deltaBuffer += chunk;
    ctx.state.deltaBufferIsCommentary = false;
  }

  if (skipLiveStream) {
    return undefined;
  }

  // Handle partial <think> tags: stream whatever reasoning is visible so far.
  // Emit-always: emitReasoningStream reaches the bus/archive; rendering +
  // message_tool_only suppression are gated downstream (#92738).
  ctx.emitReasoningStream(
    extractThinkingFromTaggedStream(ctx.state.deltaBuffer, ctx.state.thinkingTagStream, chunk),
  );
  const wasThinking = ctx.state.partialBlockState.thinking;
  let visibleDelta = "";
  let textIsAppend = false;
  let appendDelta: string | null = null;
  let previousText = ctx.state.assistantStream?.raw ?? "";
  // A text_start partial may already contain text that the following text_delta replays.
  // Use starts only for lifecycle boundaries; consume their text from delta/end events.
  const shouldReadPartialText =
    streamItemChanged ||
    (evtType === "text_end" && assistantRecord?.partial !== undefined) ||
    (shouldUsePhaseAwareBlockReply && (evtType === "text_end" || !chunk));
  const isTerminalSnapshot = evtType === "text_end" && shouldReadPartialText;
  let selectedAssistant =
    shouldUsePhaseAwareBlockReply || isResponsesTextEvent ? streamAssistant : partialAssistant;
  if (
    isTerminalSnapshot &&
    selectedAssistant === partialAssistant &&
    streamContentIndex !== undefined &&
    Array.isArray(partialAssistant.content) &&
    streamContentIndex + 1 < partialAssistant.content.length
  ) {
    // Queued provider events can share a mutable partial already containing
    // later blocks. This checkpoint owns only the prefix through its index.
    selectedAssistant = {
      ...partialAssistant,
      content: partialAssistant.content.slice(0, streamContentIndex + 1),
    };
  }
  const snapshot = isTerminalSnapshot
    ? extractAssistantStreamSnapshot(ctx, selectedAssistant)
    : undefined;
  let next = shouldReadPartialText
    ? (snapshot?.text ?? extractAssistantVisibleText(selectedAssistant)).trimEnd()
    : undefined;
  if (snapshot) {
    ctx.state.deltaBuffer = snapshot.rawText;
    ctx.state.thinkingTagStream = createThinkingTagStreamState();
    ctx.state.partialBlockState = snapshot.state;
    ctx.resetPartialReplyDirectives();
  }
  // Empty intermediate snapshots carry no new text; an end snapshot can retract it.
  if (!next && evtType !== "text_end") {
    next = undefined;
  }
  const hasSnapshotText = next !== undefined;
  let nextRawStreamText = next ?? "";
  let projection: NonNullable<EmbeddedAgentSubscribeState["assistantStream"]>["projection"];
  if (next === undefined && deliveryPhase === "final_answer" && (reprojectBlockReply || chunk)) {
    // A late phase can reveal inline examples; retain already scoped snapshots above.
    visibleDelta = reprojectBlockReply
      ? ctx.state.deltaBuffer
      : ctx.params.enforceFinalTag
        ? ctx.stripBlockTags(chunk, ctx.state.partialBlockState, { final: finalText })
        : chunk;
    next = visibleDelta;
    textIsAppend = true;
    if (reprojectBlockReply) {
      ctx.resetPartialReplyDirectives();
    }
  } else if (next === undefined && deliveryPhase !== "final_answer") {
    const pendingTagFragment = ctx.state.partialBlockState.pendingTagFragment;
    const shouldRecomputeFullStream = Boolean(pendingTagFragment) || REASONING_TAG_RE.test(chunk);
    if (shouldRecomputeFullStream) {
      const recomputeState: EmbeddedAgentSubscribeState["partialBlockState"] = {
        thinking: false,
        final: false,
        inlineCode: createInlineCodeState(),
      };
      const recomputedRawText = ctx.stripBlockTags(ctx.state.deltaBuffer, recomputeState, {
        final: finalText,
      });
      const isFullStreamReplacement = !recomputedRawText.startsWith(previousText);
      if (isFullStreamReplacement) {
        ctx.resetPartialReplyDirectives();
      }
      textIsAppend = !isFullStreamReplacement;
      next = recomputedRawText;
      visibleDelta = isFullStreamReplacement
        ? recomputedRawText
        : recomputedRawText.slice(previousText.length);
      nextRawStreamText = recomputedRawText;
      ctx.state.partialBlockState = recomputeState;
    } else {
      visibleDelta =
        chunk || evtType === "text_end"
          ? ctx.stripBlockTags(chunk, ctx.state.partialBlockState, {
              final: finalText,
            })
          : "";
      if (ctx.state.partialBlockState.pendingTagFragment) {
        visibleDelta = "";
        next = ctx.state.assistantStream?.text ?? "";
        nextRawStreamText = ctx.state.assistantStream?.raw ?? "";
      } else {
        next = visibleDelta;
        textIsAppend = true;
      }
    }
  } else if (!isTerminalSnapshot && next !== undefined && (chunk || evtType === "text_end")) {
    visibleDelta = ctx.stripBlockTags(chunk, ctx.state.partialBlockState, {
      final: finalText,
    });
  }
  if (next !== undefined) {
    // Held fence fragments change this delta before the visible projection trims it.
    const unchangedBlockAppend = textIsAppend && visibleDelta === chunk;
    if (!hasSnapshotText) {
      const kind =
        deliveryPhase !== "final_answer"
          ? "raw"
          : ctx.params.enforceFinalTag
            ? "delivery"
            : "final";
      const previousStream = reprojectBlockReply ? undefined : ctx.state.assistantStream;
      projection = previousStream?.projection;
      if (!projection || projection.kind !== kind) {
        projection = {
          kind,
          projector:
            kind === "raw"
              ? createTextProjection([
                  downgradedToolCallTextFilter(),
                  trimTextFilter("both", { preserveCodeIndentation: true }),
                ])
              : createAssistantVisibleStreamText(kind === "final" ? "final_answer" : undefined),
        };
        projection.projector.replace(previousStream?.raw ?? "");
      }
      previousText = projection.projector.text;
      if (!textIsAppend) {
        projection.directiveCodePrefix = undefined;
      }
      const projected = textIsAppend
        ? projection.projector.append(visibleDelta)
        : projection.projector.replace(nextRawStreamText);
      nextRawStreamText = projection.projector.source;
      next = projected.text;
      appendDelta = projected.delta;
      // Generic directives retain their raw chunk coordinates: restored trim whitespace
      // could otherwise make an inline tag look like an indented code block.
      if (kind !== "raw") {
        visibleDelta = projected.delta ?? (previousText.startsWith(next) ? "" : next);
      }
    }
    if (
      !suppressMessageToolOnlySourceReplyOutput &&
      !wasThinking &&
      ctx.state.partialBlockState.thinking
    ) {
      openReasoningStream(ctx);
    }
    // Detect when thinking block ends (</think> tag processed)
    if (
      !suppressMessageToolOnlySourceReplyOutput &&
      wasThinking &&
      !ctx.state.partialBlockState.thinking
    ) {
      emitReasoningEnd(ctx);
    }
    const parsedStreamDirectives = isTerminalSnapshot
      ? ctx.consumePartialReplyDirectives(next, { final: finalText })
      : mergeReplyDirectiveResults(
          visibleDelta ? ctx.consumePartialReplyDirectives(visibleDelta) : null,
          evtType === "text_end"
            ? ctx.consumePartialReplyDirectives("", { final: finalText })
            : null,
        );
    const previousCleaned = ctx.state.assistantStream?.text ?? "";
    const {
      text: cleanedText,
      delta: replyDelta,
      replace,
      hasText,
      replyDirectives,
      audioDirectiveCount,
      directiveCodePrefix,
    } = resolveStreamingReply({
      evtType,
      next,
      previousText,
      previousCleaned,
      visibleDelta,
      appendDelta,
      parsedStreamDirectives,
      previousAudioDirectiveCount: ctx.state.lastAssistantAudioDirectiveCount,
      rawDirectiveSource: projection?.kind === "raw" ? nextRawStreamText : undefined,
      directiveCodePrefix: projection?.kind === "raw" ? projection.directiveCodePrefix : undefined,
    });
    if (projection?.kind === "raw") {
      projection.directiveCodePrefix = directiveCodePrefix;
    }
    ctx.state.lastAssistantAudioDirectiveCount = audioDirectiveCount;
    recordPendingAssistantReplyDirectives(ctx.state, replyDirectives);
    const hasAudio = Boolean(replyDirectives?.audioAsVoice);

    const hasVisibleReply = hasText || hasAudio;
    const deltaText = hasVisibleReply ? replyDelta : "";
    let shouldEmit =
      (hasVisibleReply || replace) &&
      (replace ? cleanedText !== previousCleaned || hasAudio : Boolean(deltaText || hasAudio));

    if (!isPhasePendingAnthropicText && !isPhasePendingCompletionsText) {
      const plainAppend =
        evtType === "text_delta" &&
        unchangedBlockAppend &&
        !snapshot &&
        !reprojectBlockReply &&
        !replace &&
        !ctx.params.enforceFinalTag &&
        (priorBlockIndex === streamContentIndex ||
          (priorBlockIndex === undefined && !priorBlockText)) &&
        previousText === previousCleaned &&
        next === cleanedText &&
        next === nextRawStreamText.trim();
      if (plainAppend) {
        ctx.blockChunker.append(chunk);
      } else {
        const previousBlock = extractAssistantStreamSnapshot(ctx, partialAssistant, {
          throughIndex: streamItemChanged ? blockSourceIndex : priorSourceIndex,
          observedText: streamItemChanged ? "" : priorBlockText,
          final: streamItemChanged ? false : priorBlockFinal,
        });
        const nextBlock = extractAssistantStreamSnapshot(ctx, partialAssistant, {
          throughIndex: blockSourceIndex,
          ...(snapshot ? {} : { observedText: ctx.state.streamBlockText }),
          final: finalText,
        });
        reconcileBlockReplySnapshot(ctx, previousBlock, nextBlock);
      }
    }
    if (isTerminalSnapshot) {
      ctx.state.streamBlockText = content;
    }

    // Snapshot recovery discards incremental state; its scoped source seeds the next append.
    ctx.state.assistantStream = { raw: nextRawStreamText, text: cleanedText, projection };

    if (
      ctx.params.silentExpected ||
      suppressDeterministicApprovalOutput ||
      suppressMessageToolOnlySourceReplyOutput
    ) {
      shouldEmit = false;
    }

    if (shouldEmit) {
      const currentSourcePartial =
        ctx.params.sourceReplyDeliveryMode !== "message_tool_only"
          ? resolveCurrentSourceMessagingToolPartial(ctx.state, {
              evtType,
              text: cleanedText,
              visibleDelta,
            })
          : { hold: false, text: cleanedText };
      const releaseHeldSnapshot = currentSourcePartial.text !== cleanedText;
      ctx.emitAssistantStreamData(
        {
          text: currentSourcePartial.text,
          delta: releaseHeldSnapshot ? currentSourcePartial.text : deltaText,
          replace: releaseHeldSnapshot || replace || undefined,
          phase: deliveryPhase ?? assistantPhase,
        },
        { emitPartialReply: !currentSourcePartial.hold },
      );
    }
  }

  if (
    ctx.params.silentExpected ||
    suppressDeterministicApprovalOutput ||
    suppressMessageToolOnlySourceReplyOutput ||
    ctx.state.blockReplyBreak !== "text_end"
  ) {
    return undefined;
  }
  if (ctx.params.onBlockReply && ctx.blockChunking) {
    ctx.blockChunker.drain({ force: false, emit: ctx.emitBlockChunk });
  }
  if (evtType === "text_end") {
    const assistantMessageIndex = ctx.state.assistantMessageIndex;
    const onFlushError = (err: unknown) => {
      ctx.log.debug(`text_end block reply flush failed: ${String(err)}`);
    };
    try {
      const pending = ctx.flushBlockReplyBuffer({ assistantMessageIndex, final: finalText });
      if (pending) {
        return pending.catch(onFlushError);
      }
    } catch (err) {
      onFlushError(err);
    }
  }
  return undefined;
}

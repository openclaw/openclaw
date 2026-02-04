import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { createInlineCodeState } from "../markdown/code-spans.js";
import {
  isMessagingToolDuplicateNormalized,
  normalizeTextForComparison,
} from "./pi-embedded-helpers.js";
import { appendRawStream } from "./pi-embedded-subscribe.raw-stream.js";
import {
  extractAssistantText,
  extractAssistantThinking,
  extractThinkingFromTaggedStream,
  extractThinkingFromTaggedText,
  formatReasoningMessage,
  promoteThinkingTagsToBlocks,
  stripCompactionHandoffText,
} from "./pi-embedded-utils.js";

const stripTrailingDirective = (text: string): string => {
  const openIndex = text.lastIndexOf("[[");
  if (openIndex < 0) {
    return text;
  }
  const closeIndex = text.indexOf("]]", openIndex + 2);
  if (closeIndex >= 0) {
    return text;
  }
  return text.slice(0, openIndex);
};

export function handleMessageStart(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & { message: AgentMessage },
) {
  const msg = evt.message;
  if (msg?.role !== "assistant") {
    return;
  }

  // KNOWN: Resetting at `text_end` is unsafe (late/duplicate end events).
  // ASSUME: `message_start` is the only reliable boundary for “new assistant message begins”.
  // Start-of-message is a safer reset point than message_end: some providers
  // may deliver late text_end updates after message_end, which would otherwise
  // re-trigger block replies.
  ctx.resetAssistantMessageState(ctx.state.assistantTexts.length);
  appendRawStream({
    ts: Date.now(),
    event: "assistant_message_start",
    runId: ctx.params.runId,
    sessionId: (ctx.params.session as { id?: string }).id,
    sessionKey: ctx.params.sessionKey,
    assistantMessageIndex: ctx.state.assistantMessageIndex,
    assistantTextsLen: ctx.state.assistantTexts.length,
    assistantTextBaseline: ctx.state.assistantTextBaseline,
    reasoningMode: ctx.state.reasoningMode,
    includeReasoning: ctx.state.includeReasoning,
    streamReasoning: ctx.state.streamReasoning,
    emitReasoningInBlockReply: ctx.state.emitReasoningInBlockReply,
    blockReplyBreak: ctx.state.blockReplyBreak,
    enforceFinalTag: Boolean(ctx.params.enforceFinalTag),
  });
  // Use assistant message_start as the earliest "writing" signal for typing.
  void ctx.params.onAssistantMessageStart?.();
}

export function handleMessageUpdate(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & { message: AgentMessage; assistantMessageEvent?: unknown },
) {
  const msg = evt.message;
  if (msg?.role !== "assistant") {
    return;
  }

  const assistantEvent = evt.assistantMessageEvent;
  const assistantRecord =
    assistantEvent && typeof assistantEvent === "object"
      ? (assistantEvent as Record<string, unknown>)
      : undefined;
  const evtType = typeof assistantRecord?.type === "string" ? assistantRecord.type : "";

  if (evtType !== "text_delta" && evtType !== "text_start" && evtType !== "text_end") {
    return;
  }

  const delta = typeof assistantRecord?.delta === "string" ? assistantRecord.delta : "";
  const content = typeof assistantRecord?.content === "string" ? assistantRecord.content : "";

  appendRawStream({
    ts: Date.now(),
    event: "assistant_text_stream",
    runId: ctx.params.runId,
    sessionId: (ctx.params.session as { id?: string }).id,
    evtType,
    delta,
    content,
  });

  let chunk = "";
  let chunkSource: string = evtType;
  if (evtType === "text_delta") {
    chunk = delta;
    chunkSource = "delta";
  } else if (evtType === "text_start" || evtType === "text_end") {
    if (delta) {
      chunk = delta;
      chunkSource = "delta";
    } else if (content) {
      // KNOWN: Some providers resend full content on `text_end`.
      // We only append a suffix (or nothing) to keep output monotonic.
      if (content.startsWith(ctx.state.deltaBuffer)) {
        chunk = content.slice(ctx.state.deltaBuffer.length);
        chunkSource = "content_suffix";
      } else if (ctx.state.deltaBuffer.startsWith(content)) {
        chunk = "";
        chunkSource = "content_prefix";
      } else if (!ctx.state.deltaBuffer.includes(content)) {
        chunk = content;
        chunkSource = "content_replace";
      } else {
        chunkSource = "content_noop";
      }
    }
  }

  if (chunk) {
    const prevDeltaLen = ctx.state.deltaBuffer.length;
    const prevBlockLen = ctx.state.blockBuffer.length;
    const hadChunker = Boolean(ctx.blockChunker);
    const prevChunkerBuffered = ctx.blockChunker?.hasBuffered() ?? false;
    ctx.state.deltaBuffer += chunk;
    if (ctx.blockChunker) {
      ctx.blockChunker.append(chunk);
    } else {
      ctx.state.blockBuffer += chunk;
    }
    appendRawStream({
      ts: Date.now(),
      event: "assistant_text_buffer_append",
      runId: ctx.params.runId,
      sessionId: (ctx.params.session as { id?: string }).id,
      sessionKey: ctx.params.sessionKey,
      assistantMessageIndex: ctx.state.assistantMessageIndex,
      evtType,
      chunkSource,
      chunkLen: chunk.length,
      prevDeltaLen,
      nextDeltaLen: ctx.state.deltaBuffer.length,
      prevBlockLen,
      nextBlockLen: ctx.state.blockBuffer.length,
      hasChunker: hadChunker,
      prevChunkerBuffered,
      nextChunkerBuffered: ctx.blockChunker?.hasBuffered() ?? false,
      blockReplyBreak: ctx.state.blockReplyBreak,
      enforceFinalTag: Boolean(ctx.params.enforceFinalTag),
    });
  } else if (content || delta) {
    // Even when no chunk is produced (monotonic guard), record why.
    appendRawStream({
      ts: Date.now(),
      event: "assistant_text_buffer_noop",
      runId: ctx.params.runId,
      sessionId: (ctx.params.session as { id?: string }).id,
      sessionKey: ctx.params.sessionKey,
      assistantMessageIndex: ctx.state.assistantMessageIndex,
      evtType,
      chunkSource,
      deltaLen: delta.length,
      contentLen: content.length,
      deltaBufferLen: ctx.state.deltaBuffer.length,
    });
  }

  if (ctx.state.streamReasoning) {
    // Handle partial <think> tags: stream whatever reasoning is visible so far.
    const visibleThinking = extractThinkingFromTaggedStream(ctx.state.deltaBuffer);
    appendRawStream({
      ts: Date.now(),
      event: "assistant_reasoning_extract_partial",
      runId: ctx.params.runId,
      sessionId: (ctx.params.session as { id?: string }).id,
      sessionKey: ctx.params.sessionKey,
      assistantMessageIndex: ctx.state.assistantMessageIndex,
      deltaBufferLen: ctx.state.deltaBuffer.length,
      extractedLen: visibleThinking.length,
    });
    ctx.emitReasoningStream(visibleThinking);
  }

  const next = ctx
    .stripBlockTags(ctx.state.deltaBuffer, {
      thinking: false,
      final: false,
      inlineCode: createInlineCodeState(),
    })
    .trim();
  if (next) {
    const visibleDelta = chunk ? ctx.stripBlockTags(chunk, ctx.state.partialBlockState) : "";
    const parsedDelta = visibleDelta ? ctx.consumePartialReplyDirectives(visibleDelta) : null;
    const parsedFull = parseReplyDirectives(stripTrailingDirective(next));
    const cleanedText = stripCompactionHandoffText(parsedFull.text);
    const mediaUrls = parsedDelta?.mediaUrls;
    const hasMedia = Boolean(mediaUrls && mediaUrls.length > 0);
    const hasAudio = Boolean(parsedDelta?.audioAsVoice);
    const previousCleaned = ctx.state.lastStreamedAssistantCleaned ?? "";

    let shouldEmit = false;
    let deltaText = "";
    if (!cleanedText && !hasMedia && !hasAudio) {
      shouldEmit = false;
    } else if (previousCleaned && !cleanedText.startsWith(previousCleaned)) {
      shouldEmit = false;
    } else {
      deltaText = cleanedText.slice(previousCleaned.length);
      shouldEmit = Boolean(deltaText || hasMedia || hasAudio);
    }

    ctx.state.lastStreamedAssistant = next;
    ctx.state.lastStreamedAssistantCleaned = cleanedText;

    appendRawStream({
      ts: Date.now(),
      event: "assistant_text_visible_delta",
      runId: ctx.params.runId,
      sessionId: (ctx.params.session as { id?: string }).id,
      sessionKey: ctx.params.sessionKey,
      assistantMessageIndex: ctx.state.assistantMessageIndex,
      evtType,
      chunkSource,
      rawNextLen: next.length,
      cleanedTextLen: cleanedText.length,
      previousCleanedLen: previousCleaned.length,
      computedDeltaLen: deltaText.length,
      shouldEmit,
      hasMedia,
      hasAudio,
    });

    if (shouldEmit) {
      emitAgentEvent({
        runId: ctx.params.runId,
        stream: "assistant",
        data: {
          text: cleanedText,
          delta: deltaText,
          mediaUrls: hasMedia ? mediaUrls : undefined,
        },
      });
      void ctx.params.onAgentEvent?.({
        stream: "assistant",
        data: {
          text: cleanedText,
          delta: deltaText,
          mediaUrls: hasMedia ? mediaUrls : undefined,
        },
      });
      if (ctx.params.onPartialReply && ctx.state.shouldEmitPartialReplies) {
        void ctx.params.onPartialReply({
          text: cleanedText,
          mediaUrls: hasMedia ? mediaUrls : undefined,
        });
      }
    }
  }

  if (ctx.params.onBlockReply && ctx.blockChunking && ctx.state.blockReplyBreak === "text_end") {
    ctx.blockChunker?.drain({ force: false, emit: ctx.emitBlockChunk });
  }

  if (evtType === "text_end" && ctx.state.blockReplyBreak === "text_end") {
    if (ctx.blockChunker?.hasBuffered()) {
      ctx.blockChunker.drain({ force: true, emit: ctx.emitBlockChunk });
      ctx.blockChunker.reset();
    } else if (ctx.state.blockBuffer.length > 0) {
      ctx.emitBlockChunk(ctx.state.blockBuffer);
      ctx.state.blockBuffer = "";
    }
  }
}

export function handleMessageEnd(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & { message: AgentMessage },
) {
  const msg = evt.message;
  if (msg?.role !== "assistant") {
    return;
  }

  const assistantMessage = msg;
  promoteThinkingTagsToBlocks(assistantMessage);

  const rawText = extractAssistantText(assistantMessage);
  appendRawStream({
    ts: Date.now(),
    event: "assistant_message_end",
    runId: ctx.params.runId,
    sessionId: (ctx.params.session as { id?: string }).id,
    rawText,
    rawThinking: extractAssistantThinking(assistantMessage),
  });

  const text = stripCompactionHandoffText(
    ctx.stripBlockTags(rawText, { thinking: false, final: false }),
  );
  const rawThinking =
    ctx.state.includeReasoning || ctx.state.streamReasoning
      ? extractAssistantThinking(assistantMessage) || extractThinkingFromTaggedText(rawText)
      : "";
  const formattedReasoning = rawThinking ? formatReasoningMessage(rawThinking) : "";

  appendRawStream({
    ts: Date.now(),
    event: "assistant_message_end_normalized",
    runId: ctx.params.runId,
    sessionId: (ctx.params.session as { id?: string }).id,
    sessionKey: ctx.params.sessionKey,
    assistantMessageIndex: ctx.state.assistantMessageIndex,
    rawTextLen: rawText.length,
    normalizedTextLen: text.length,
    rawThinkingLen: rawThinking.length,
    formattedReasoningLen: formattedReasoning.length,
    includeReasoning: ctx.state.includeReasoning,
    streamReasoning: ctx.state.streamReasoning,
    emitReasoningInBlockReply: ctx.state.emitReasoningInBlockReply,
    hasReasoningStreamCallback: typeof ctx.params.onReasoningStream === "function",
    hasOnBlockReply: typeof ctx.params.onBlockReply === "function",
    blockReplyBreak: ctx.state.blockReplyBreak,
    enforceFinalTag: Boolean(ctx.params.enforceFinalTag),
  });

  const addedDuringMessage = ctx.state.assistantTexts.length > ctx.state.assistantTextBaseline;
  const chunkerHasBuffered = ctx.blockChunker?.hasBuffered() ?? false;
  ctx.finalizeAssistantTexts({ text, addedDuringMessage, chunkerHasBuffered });

  const onBlockReply = ctx.params.onBlockReply;
  const hasReasoningStreamCallback = typeof ctx.params.onReasoningStream === "function";

  // Reasoning emission priority:
  // 1. If onReasoningStream callback is provided -> emit via that (handled at end of function)
  // 2. Else if emitReasoningInBlockReply is true -> emit via onBlockReply (fallback for inline display)
  // 3. Else -> don't emit reasoning to user-facing surfaces (channels like Discord, Slack, etc.)
  //
  // This prevents reasoning from leaking into channel messages while allowing:
  // - TUI/Web UI to receive reasoning via onReasoningStream (with frontend toggle control)
  // - Explicit opt-in for inline reasoning in block replies when no stream callback exists
  const shouldEmitReasoningViaBlockReply = Boolean(
    ctx.state.includeReasoning &&
    formattedReasoning &&
    onBlockReply &&
    ctx.state.emitReasoningInBlockReply && // Must explicitly opt-in to emit reasoning via block reply
    !hasReasoningStreamCallback && // Don't use block reply if onReasoningStream is available
    formattedReasoning !== ctx.state.lastReasoningSent,
  );
  const shouldEmitReasoningBeforeAnswer =
    shouldEmitReasoningViaBlockReply &&
    ctx.state.blockReplyBreak === "message_end" &&
    !addedDuringMessage;
  const maybeEmitReasoningViaBlockReply = () => {
    if (!shouldEmitReasoningViaBlockReply || !formattedReasoning) {
      appendRawStream({
        ts: Date.now(),
        event: "assistant_reasoning_block_decision",
        runId: ctx.params.runId,
        sessionId: (ctx.params.session as { id?: string }).id,
        sessionKey: ctx.params.sessionKey,
        assistantMessageIndex: ctx.state.assistantMessageIndex,
        willEmit: false,
        includeReasoning: ctx.state.includeReasoning,
        emitReasoningInBlockReply: ctx.state.emitReasoningInBlockReply,
        hasReasoningStreamCallback,
        formattedReasoningLen: formattedReasoning.length,
        alreadySent: formattedReasoning === ctx.state.lastReasoningSent,
        blockReplyBreak: ctx.state.blockReplyBreak,
      });
      return;
    }
    appendRawStream({
      ts: Date.now(),
      event: "assistant_reasoning_block_decision",
      runId: ctx.params.runId,
      sessionId: (ctx.params.session as { id?: string }).id,
      sessionKey: ctx.params.sessionKey,
      assistantMessageIndex: ctx.state.assistantMessageIndex,
      willEmit: true,
      when: shouldEmitReasoningBeforeAnswer ? "before_answer" : "after_answer",
      formattedReasoningLen: formattedReasoning.length,
      blockReplyBreak: ctx.state.blockReplyBreak,
    });
    ctx.state.lastReasoningSent = formattedReasoning;
    void onBlockReply?.({ text: formattedReasoning });
  };

  if (shouldEmitReasoningBeforeAnswer) {
    maybeEmitReasoningViaBlockReply();
  }

  if (
    (ctx.state.blockReplyBreak === "message_end" ||
      (ctx.blockChunker ? ctx.blockChunker.hasBuffered() : ctx.state.blockBuffer.length > 0)) &&
    text &&
    onBlockReply
  ) {
    if (ctx.blockChunker?.hasBuffered()) {
      ctx.blockChunker.drain({ force: true, emit: ctx.emitBlockChunk });
      ctx.blockChunker.reset();
    } else if (text !== ctx.state.lastBlockReplyText) {
      // Check for duplicates before emitting (same logic as emitBlockChunk).
      const normalizedText = normalizeTextForComparison(text);
      if (
        isMessagingToolDuplicateNormalized(
          normalizedText,
          ctx.state.messagingToolSentTextsNormalized,
        )
      ) {
        ctx.log.debug(
          `Skipping message_end block reply - already sent via messaging tool: ${text.slice(0, 50)}...`,
        );
        appendRawStream({
          ts: Date.now(),
          event: "assistant_message_end_block_skip",
          runId: ctx.params.runId,
          sessionId: (ctx.params.session as { id?: string }).id,
          sessionKey: ctx.params.sessionKey,
          assistantMessageIndex: ctx.state.assistantMessageIndex,
          reason: "duplicate_messaging_tool",
          textLen: text.length,
          blockReplyBreak: ctx.state.blockReplyBreak,
        });
      } else {
        ctx.state.lastBlockReplyText = text;
        const splitResult = ctx.consumeReplyDirectives(text, { final: true });
        if (splitResult) {
          const {
            text: cleanedText,
            mediaUrls,
            audioAsVoice,
            replyToId,
            replyToTag,
            replyToCurrent,
          } = splitResult;
          // Emit if there's content OR audioAsVoice flag (to propagate the flag).
          if (cleanedText || (mediaUrls && mediaUrls.length > 0) || audioAsVoice) {
            appendRawStream({
              ts: Date.now(),
              event: "assistant_message_end_block_emit",
              runId: ctx.params.runId,
              sessionId: (ctx.params.session as { id?: string }).id,
              sessionKey: ctx.params.sessionKey,
              assistantMessageIndex: ctx.state.assistantMessageIndex,
              textLen: text.length,
              cleanedLen: cleanedText?.length ?? 0,
              mediaCount: mediaUrls?.length ?? 0,
              audioAsVoice: Boolean(audioAsVoice),
              replyToId: replyToId ?? undefined,
              startsWithReasoning: cleanedText ? cleanedText.startsWith("Reasoning:") : false,
              blockReplyBreak: ctx.state.blockReplyBreak,
            });
            void onBlockReply({
              text: cleanedText,
              mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
              audioAsVoice,
              replyToId,
              replyToTag,
              replyToCurrent,
            });
          }
        }
      }
    }
  }

  if (!shouldEmitReasoningBeforeAnswer) {
    maybeEmitReasoningViaBlockReply();
  }

  // Emit reasoning via onReasoningStream if callback is provided and we have reasoning.
  // This works for both "on" and "stream" modes - the frontend/TUI decides what to display.
  // For "stream" mode, real-time deltas are also emitted during handleMessageUpdate.
  const shouldEmitReasoningViaStream =
    hasReasoningStreamCallback &&
    rawThinking &&
    (ctx.state.includeReasoning || ctx.state.streamReasoning);
  if (shouldEmitReasoningViaStream) {
    ctx.emitReasoningStream(rawThinking);
  }

  if (ctx.state.blockReplyBreak === "text_end" && onBlockReply) {
    const tailResult = ctx.consumeReplyDirectives("", { final: true });
    if (tailResult) {
      const {
        text: cleanedText,
        mediaUrls,
        audioAsVoice,
        replyToId,
        replyToTag,
        replyToCurrent,
      } = tailResult;
      if (cleanedText || (mediaUrls && mediaUrls.length > 0) || audioAsVoice) {
        void onBlockReply({
          text: cleanedText,
          mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
          audioAsVoice,
          replyToId,
          replyToTag,
          replyToCurrent,
        });
      }
    }
  }

  ctx.state.deltaBuffer = "";
  ctx.state.blockBuffer = "";
  ctx.blockChunker?.reset();
  ctx.state.blockState.thinking = false;
  ctx.state.blockState.final = false;
  ctx.state.blockState.inlineCode = createInlineCodeState();
  ctx.state.lastStreamedAssistant = undefined;
  ctx.state.lastStreamedAssistantCleaned = undefined;
}

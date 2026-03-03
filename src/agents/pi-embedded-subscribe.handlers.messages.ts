import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { createInlineCodeState } from "../markdown/code-spans.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import {
  isMessagingToolDuplicateNormalized,
  normalizeTextForComparison,
} from "./pi-embedded-helpers.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { appendRawStream } from "./pi-embedded-subscribe.raw-stream.js";
import {
  extractAssistantText,
  extractAssistantThinking,
  extractThinkingFromTaggedStream,
  extractThinkingFromTaggedText,
  formatReasoningMessage,
  promoteThinkingTagsToBlocks,
  stripDowngradedToolCallText,
  stripMinimaxToolCallXml,
  stripThinkingTagsFromText,
} from "./pi-embedded-utils.js";

const stripTrailingDirective = (text: string): string => {
  const openIndex = text.lastIndexOf("[[");
  if (openIndex < 0) {
    if (text.endsWith("[")) {
      return text.slice(0, -1);
    }
    return text;
  }
  const closeIndex = text.indexOf("]]", openIndex + 2);
  if (closeIndex >= 0) {
    return text;
  }
  return text.slice(0, openIndex);
};

const areMediaUrlsEqual = (left?: string[], right?: string[]): boolean => {
  const leftList = left ?? [];
  const rightList = right ?? [];
  if (leftList.length !== rightList.length) {
    return false;
  }
  for (let i = 0; i < leftList.length; i += 1) {
    if (leftList[i] !== rightList[i]) {
      return false;
    }
  }
  return true;
};

function emitReasoningEnd(ctx: EmbeddedPiSubscribeContext) {
  if (!ctx.state.reasoningStreamOpen) {
    return;
  }
  ctx.state.reasoningStreamOpen = false;
  void ctx.params.onReasoningEnd?.();
}

export function resolveSilentReplyFallbackText(params: {
  text: string;
  messagingToolSentTexts: string[];
}): string {
  const trimmed = params.text.trim();
  if (trimmed !== SILENT_REPLY_TOKEN) {
    return params.text;
  }
  const fallback = params.messagingToolSentTexts.at(-1)?.trim();
  if (!fallback) {
    return params.text;
  }
  return fallback;
}

function syncSnapshotIntoTextBuffers(ctx: EmbeddedPiSubscribeContext, snapshot: string) {
  if (!snapshot || snapshot === ctx.state.deltaBuffer) {
    return;
  }

  if (snapshot.startsWith(ctx.state.deltaBuffer)) {
    const missing = snapshot.slice(ctx.state.deltaBuffer.length);
    if (!missing) {
      return;
    }
    ctx.state.deltaBuffer += missing;
    if (ctx.blockChunker) {
      ctx.blockChunker.append(missing);
    } else {
      ctx.state.blockBuffer += missing;
    }
    return;
  }

  ctx.state.deltaBuffer = snapshot;
  if (ctx.blockChunker) {
    ctx.blockChunker.reset();
    ctx.blockChunker.append(snapshot);
  } else {
    ctx.state.blockBuffer = snapshot;
  }
}

function extractAssistantRawSnapshotText(msg: AgentMessage): string {
  const content = (msg as { content?: unknown }).content;
  return (
    extractTextFromChatContent(content, {
      sanitizeText: (text) =>
        stripThinkingTagsFromText(stripDowngradedToolCallText(stripMinimaxToolCallXml(text))),
      joinWith: "\n",
      normalizeText: (text) => text,
    }) ?? ""
  );
}

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

  ctx.noteLastAssistant(msg);

  const assistantEvent = evt.assistantMessageEvent;
  const assistantRecord =
    assistantEvent && typeof assistantEvent === "object"
      ? (assistantEvent as Record<string, unknown>)
      : undefined;
  const evtType = typeof assistantRecord?.type === "string" ? assistantRecord.type : "";

  if (evtType === "thinking_start" || evtType === "thinking_delta" || evtType === "thinking_end") {
    if (evtType === "thinking_start" || evtType === "thinking_delta") {
      ctx.state.reasoningStreamOpen = true;
    }
    const thinkingDelta = typeof assistantRecord?.delta === "string" ? assistantRecord.delta : "";
    const thinkingContent =
      typeof assistantRecord?.content === "string" ? assistantRecord.content : "";
    appendRawStream({
      ts: Date.now(),
      event: "assistant_thinking_stream",
      runId: ctx.params.runId,
      sessionId: (ctx.params.session as { id?: string }).id,
      evtType,
      delta: thinkingDelta,
      content: thinkingContent,
    });
    if (ctx.state.streamReasoning) {
      // Prefer full partial-message thinking when available; fall back to event payloads.
      const partialThinking = extractAssistantThinking(msg);
      ctx.emitReasoningStream(partialThinking || thinkingContent || thinkingDelta);
    }
    if (evtType === "thinking_end") {
      if (!ctx.state.reasoningStreamOpen) {
        ctx.state.reasoningStreamOpen = true;
      }
      emitReasoningEnd(ctx);
    }
    return;
  }

  if (evtType !== "text_delta" && evtType !== "text_start" && evtType !== "text_end") {
    // Some providers emit non-text assistant update events (for example
    // toolcall/start markers) while still mutating the partial assistant text.
    // Fall back to diffing the current assistant snapshot so channel preview
    // streaming continues to receive incremental updates.
    if (evtType) {
      const rawAssistantText = extractAssistantRawSnapshotText(msg);
      const snapshotRaw = ctx.stripBlockTags(rawAssistantText, {
        thinking: false,
        final: false,
        inlineCode: createInlineCodeState(),
      });
      const snapshot = snapshotRaw.trim();
      if (!snapshot) {
        return;
      }

      const parsedSnapshot = parseReplyDirectives(stripTrailingDirective(snapshot));
      const cleanedText = parsedSnapshot.text;
      const mediaUrls = parsedSnapshot.mediaUrls;
      const hasMedia = Boolean(mediaUrls && mediaUrls.length > 0);
      const hasAudio = Boolean(parsedSnapshot.audioAsVoice);
      const previousCleaned = ctx.state.lastStreamedAssistantCleaned ?? "";
      const previousSnapshot = ctx.state.lastStreamedAssistant?.trim();
      const previousParsed = previousSnapshot
        ? parseReplyDirectives(stripTrailingDirective(previousSnapshot))
        : null;
      const mediaChanged = !areMediaUrlsEqual(mediaUrls, previousParsed?.mediaUrls);
      const audioChanged = hasAudio !== Boolean(previousParsed?.audioAsVoice);

      let shouldEmit = false;
      let deltaText = "";
      if (!cleanedText && !hasMedia && !hasAudio) {
        shouldEmit = false;
      } else if (previousCleaned && !cleanedText.startsWith(previousCleaned)) {
        shouldEmit = false;
      } else {
        deltaText = cleanedText.slice(previousCleaned.length);
        shouldEmit = Boolean(deltaText || mediaChanged || audioChanged);
      }

      if (shouldEmit) {
        if (cleanedText) {
          syncSnapshotIntoTextBuffers(ctx, snapshotRaw);
        }
        ctx.state.lastStreamedAssistant = snapshotRaw;
        ctx.state.lastStreamedAssistantCleaned = cleanedText;
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
        ctx.state.emittedAssistantUpdate = true;
        if (ctx.params.onPartialReply && ctx.state.shouldEmitPartialReplies) {
          void ctx.params.onPartialReply({
            text: cleanedText,
            mediaUrls: hasMedia ? mediaUrls : undefined,
          });
        }
      }
    }
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
  if (evtType === "text_delta") {
    chunk = delta;
  } else if (evtType === "text_start" || evtType === "text_end") {
    if (delta) {
      chunk = delta;
    } else if (content) {
      // KNOWN: Some providers resend full content on `text_end`.
      // We only append a suffix (or nothing) to keep output monotonic.
      if (content.startsWith(ctx.state.deltaBuffer)) {
        chunk = content.slice(ctx.state.deltaBuffer.length);
      } else if (ctx.state.deltaBuffer.startsWith(content)) {
        chunk = "";
      } else if (!ctx.state.deltaBuffer.includes(content)) {
        chunk = content;
      }
    }
  }

  if (chunk) {
    ctx.state.deltaBuffer += chunk;
    if (ctx.blockChunker) {
      ctx.blockChunker.append(chunk);
    } else {
      ctx.state.blockBuffer += chunk;
    }
  }

  if (ctx.state.streamReasoning) {
    // Handle partial <think> tags: stream whatever reasoning is visible so far.
    ctx.emitReasoningStream(extractThinkingFromTaggedStream(ctx.state.deltaBuffer));
  }

  const next = ctx
    .stripBlockTags(ctx.state.deltaBuffer, {
      thinking: false,
      final: false,
      inlineCode: createInlineCodeState(),
    })
    .trim();
  if (next) {
    const wasThinking = ctx.state.partialBlockState.thinking;
    const visibleDelta = chunk ? ctx.stripBlockTags(chunk, ctx.state.partialBlockState) : "";
    if (!wasThinking && ctx.state.partialBlockState.thinking) {
      ctx.state.reasoningStreamOpen = true;
    }
    // Detect when thinking block ends (</think> tag processed)
    if (wasThinking && !ctx.state.partialBlockState.thinking) {
      emitReasoningEnd(ctx);
    }
    const parsedDelta = visibleDelta ? ctx.consumePartialReplyDirectives(visibleDelta) : null;
    const parsedFull = parseReplyDirectives(stripTrailingDirective(next));
    const cleanedText = parsedFull.text;
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
      ctx.state.emittedAssistantUpdate = true;
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
    ctx.flushBlockReplyBuffer();
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
  ctx.noteLastAssistant(assistantMessage);
  ctx.recordAssistantUsage((assistantMessage as { usage?: unknown }).usage);
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

  const text = resolveSilentReplyFallbackText({
    text: ctx.stripBlockTags(rawText, { thinking: false, final: false }),
    messagingToolSentTexts: ctx.state.messagingToolSentTexts,
  });
  const rawThinking =
    ctx.state.includeReasoning || ctx.state.streamReasoning
      ? extractAssistantThinking(assistantMessage) || extractThinkingFromTaggedText(rawText)
      : "";
  const formattedReasoning = rawThinking ? formatReasoningMessage(rawThinking) : "";
  const trimmedText = text.trim();
  const parsedText = trimmedText ? parseReplyDirectives(stripTrailingDirective(trimmedText)) : null;
  let cleanedText = parsedText?.text ?? "";
  let mediaUrls = parsedText?.mediaUrls;
  let hasMedia = Boolean(mediaUrls && mediaUrls.length > 0);
  let finalSnapshot = trimmedText;

  if (!cleanedText && !hasMedia && !ctx.params.enforceFinalTag) {
    const rawTrimmed = rawText.trim();
    const rawStrippedFinal = rawTrimmed.replace(/<\s*\/?\s*final\s*>/gi, "").trim();
    const rawCandidate = rawStrippedFinal || rawTrimmed;
    if (rawCandidate) {
      finalSnapshot = rawCandidate;
      const parsedFallback = parseReplyDirectives(stripTrailingDirective(rawCandidate));
      cleanedText = parsedFallback.text ?? rawCandidate;
      mediaUrls = parsedFallback.mediaUrls;
      hasMedia = Boolean(mediaUrls && mediaUrls.length > 0);
    }
  }

  const previousSnapshot = ctx.state.lastStreamedAssistant?.trim();
  const previousParsed = previousSnapshot
    ? parseReplyDirectives(stripTrailingDirective(previousSnapshot))
    : null;
  const previousCleaned = previousParsed?.text ?? ctx.state.lastStreamedAssistantCleaned;
  const previousMediaUrls = previousParsed?.mediaUrls;
  const hasPreviousAssistantSnapshot = Boolean(
    ctx.state.emittedAssistantUpdate ||
    previousSnapshot ||
    ctx.state.lastStreamedAssistantCleaned !== undefined,
  );
  const sameMediaUrls = areMediaUrlsEqual(mediaUrls, previousMediaUrls);
  const sameAssistantPayload =
    hasPreviousAssistantSnapshot && cleanedText === (previousCleaned ?? "") && sameMediaUrls;
  let shouldEmitFinalAssistant = false;
  let finalDeltaText = cleanedText;
  if ((cleanedText || hasMedia) && !sameAssistantPayload) {
    const previousCleanedValue = previousCleaned ?? "";
    if (!ctx.state.emittedAssistantUpdate || !hasPreviousAssistantSnapshot) {
      shouldEmitFinalAssistant = true;
      finalDeltaText = cleanedText;
    } else if (cleanedText.startsWith(previousCleanedValue)) {
      finalDeltaText = cleanedText.slice(previousCleanedValue.length);
      shouldEmitFinalAssistant = Boolean(finalDeltaText || (hasMedia && !sameMediaUrls));
    } else if (cleanedText !== previousCleanedValue) {
      // When providers rewrite earlier text, emit the full reconciled text.
      finalDeltaText = cleanedText;
      shouldEmitFinalAssistant = true;
    }
  }

  if (shouldEmitFinalAssistant) {
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "assistant",
      data: {
        text: cleanedText,
        delta: finalDeltaText,
        mediaUrls: hasMedia ? mediaUrls : undefined,
      },
    });
    void ctx.params.onAgentEvent?.({
      stream: "assistant",
      data: {
        text: cleanedText,
        delta: finalDeltaText,
        mediaUrls: hasMedia ? mediaUrls : undefined,
      },
    });
    ctx.state.emittedAssistantUpdate = true;
    ctx.state.lastStreamedAssistant = finalSnapshot || cleanedText;
    ctx.state.lastStreamedAssistantCleaned = cleanedText;
  }

  const addedDuringMessage = ctx.state.assistantTexts.length > ctx.state.assistantTextBaseline;
  const chunkerHasBuffered = ctx.blockChunker?.hasBuffered() ?? false;
  ctx.finalizeAssistantTexts({ text, addedDuringMessage, chunkerHasBuffered });

  const onBlockReply = ctx.params.onBlockReply;
  const shouldEmitReasoning = Boolean(
    ctx.state.includeReasoning &&
    formattedReasoning &&
    onBlockReply &&
    formattedReasoning !== ctx.state.lastReasoningSent,
  );
  const shouldEmitReasoningBeforeAnswer =
    shouldEmitReasoning && ctx.state.blockReplyBreak === "message_end" && !addedDuringMessage;
  const maybeEmitReasoning = () => {
    if (!shouldEmitReasoning || !formattedReasoning) {
      return;
    }
    ctx.state.lastReasoningSent = formattedReasoning;
    void onBlockReply?.({ text: formattedReasoning, isReasoning: true });
  };

  if (shouldEmitReasoningBeforeAnswer) {
    maybeEmitReasoning();
  }

  const emitSplitResultAsBlockReply = (
    splitResult: ReturnType<typeof ctx.consumeReplyDirectives> | null | undefined,
  ) => {
    if (!splitResult || !onBlockReply) {
      return;
    }
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
      void onBlockReply({
        text: cleanedText,
        mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
        audioAsVoice,
        replyToId,
        replyToTag,
        replyToCurrent,
      });
    }
  };

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
      } else {
        ctx.state.lastBlockReplyText = text;
        emitSplitResultAsBlockReply(ctx.consumeReplyDirectives(text, { final: true }));
      }
    }
  }

  if (!shouldEmitReasoningBeforeAnswer) {
    maybeEmitReasoning();
  }
  if (ctx.state.streamReasoning && rawThinking) {
    ctx.emitReasoningStream(rawThinking);
  }

  if (ctx.state.blockReplyBreak === "text_end" && onBlockReply) {
    emitSplitResultAsBlockReply(ctx.consumeReplyDirectives("", { final: true }));
  }

  ctx.state.deltaBuffer = "";
  ctx.state.blockBuffer = "";
  ctx.blockChunker?.reset();
  ctx.state.blockState.thinking = false;
  ctx.state.blockState.final = false;
  ctx.state.blockState.inlineCode = createInlineCodeState();
  // Keep last streamed assistant snapshots until the next message_start reset so
  // duplicate/late message_end events can still be reconciled safely.
  ctx.state.reasoningStreamOpen = false;
}

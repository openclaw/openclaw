import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  emitDiagnosticEvent,
  type GenAiMessage,
  type GenAiPart,
} from "../infra/diagnostic-events.js";
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
} from "./pi-embedded-utils.js";
import { derivePromptTokens, normalizeUsage } from "./usage.js";

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

const buildAssistantParts = (content: unknown): GenAiPart[] => {
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: GenAiPart[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      parts.push({ type: "text", content: record.text });
      continue;
    }
    if (record.type === "thinking" && typeof record.thinking === "string") {
      parts.push({ type: "reasoning", content: record.thinking });
      continue;
    }
    if (record.type === "toolCall") {
      const id = typeof record.id === "string" ? record.id : "";
      const name = typeof record.name === "string" ? record.name : "";
      const args =
        record.arguments && typeof record.arguments === "object" && !Array.isArray(record.arguments)
          ? (record.arguments as Record<string, unknown>)
          : undefined;
      parts.push({ type: "tool_call", id, name, ...(args ? { arguments: args } : {}) });
      continue;
    }
    if (record.type === "image" && typeof record.data === "string") {
      parts.push({
        type: "blob",
        modality: "image",
        mime_type: typeof record.mimeType === "string" ? record.mimeType : undefined,
        content: record.data,
      });
    }
  }
  return parts;
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
  ctx.state.currentMessageStartAt = Date.now();
  ctx.state.currentMessageFirstTokenAt = undefined;
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
    ctx.state.firstTokenAt ??= Date.now();
    ctx.state.currentMessageFirstTokenAt ??= Date.now();
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

  if (!cleanedText && !hasMedia) {
    const rawTrimmed = rawText.trim();
    const rawStrippedFinal = rawTrimmed.replace(/<\s*\/?\s*final\s*>/gi, "").trim();
    const rawCandidate = rawStrippedFinal || rawTrimmed;
    if (rawCandidate) {
      const parsedFallback = parseReplyDirectives(stripTrailingDirective(rawCandidate));
      cleanedText = parsedFallback.text ?? rawCandidate;
      mediaUrls = parsedFallback.mediaUrls;
      hasMedia = Boolean(mediaUrls && mediaUrls.length > 0);
    }
  }

  if (!ctx.state.emittedAssistantUpdate && (cleanedText || hasMedia)) {
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "assistant",
      data: {
        text: cleanedText,
        delta: cleanedText,
        mediaUrls: hasMedia ? mediaUrls : undefined,
      },
    });
    void ctx.params.onAgentEvent?.({
      stream: "assistant",
      data: {
        text: cleanedText,
        delta: cleanedText,
        mediaUrls: hasMedia ? mediaUrls : undefined,
      },
    });
    ctx.state.emittedAssistantUpdate = true;
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
    void onBlockReply?.({ text: formattedReasoning });
  };

  if (shouldEmitReasoningBeforeAnswer) {
    maybeEmitReasoning();
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
    maybeEmitReasoning();
  }
  if (ctx.state.streamReasoning && rawThinking) {
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
  ctx.state.reasoningStreamOpen = false;

  const messageStartAt = ctx.state.currentMessageStartAt;
  const durationMs =
    typeof messageStartAt === "number" ? Math.max(0, Date.now() - messageStartAt) : undefined;
  const ttftMs =
    typeof messageStartAt === "number" && typeof ctx.state.currentMessageFirstTokenAt === "number"
      ? Math.max(0, ctx.state.currentMessageFirstTokenAt - messageStartAt)
      : undefined;

  const usage = normalizeUsage({
    input: (assistantMessage as { usage?: { input?: number } }).usage?.input,
    output: (assistantMessage as { usage?: { output?: number } }).usage?.output,
    cacheRead: (assistantMessage as { usage?: { cacheRead?: number } }).usage?.cacheRead,
    cacheWrite: (assistantMessage as { usage?: { cacheWrite?: number } }).usage?.cacheWrite,
    total: (assistantMessage as { usage?: { totalTokens?: number } }).usage?.totalTokens,
  });
  const promptTokens = derivePromptTokens(usage);
  const totalTokens =
    usage?.total ??
    (typeof promptTokens === "number" && typeof usage?.output === "number"
      ? promptTokens + usage.output
      : undefined);
  const stopReason = (assistantMessage as { stopReason?: string }).stopReason;
  const finishReasons = stopReason
    ? [stopReason === "toolUse" ? "tool_call" : stopReason]
    : undefined;
  const error =
    stopReason === "error" || stopReason === "aborted"
      ? ((assistantMessage as { errorMessage?: string }).errorMessage ?? "LLM request failed.")
      : undefined;

  // Content capture is intentionally opt-in and controlled by diagnostics.otel.captureContent.
  // When disabled, we still emit timings/usage/errors but omit message content fields.
  const outputParts =
    ctx.params.captureContent === true
      ? buildAssistantParts((assistantMessage as { content?: unknown }).content)
      : [];
  const outputMessages: GenAiMessage[] =
    ctx.params.captureContent === true && outputParts.length
      ? [
          {
            role: "assistant",
            parts: outputParts,
            ...(finishReasons?.length ? { finish_reason: finishReasons[0] } : {}),
          },
        ]
      : [];

  emitDiagnosticEvent({
    type: "model.inference",
    runId: ctx.params.runId,
    sessionKey: ctx.params.sessionKey,
    sessionId: ctx.params.sessionId ?? (ctx.params.session as { id?: string }).id,
    channel: ctx.params.channel,
    usage: {
      input: usage?.input,
      output: usage?.output,
      cacheRead: usage?.cacheRead,
      cacheWrite: usage?.cacheWrite,
      promptTokens,
      total: totalTokens,
    },
    provider: (assistantMessage as { provider?: string }).provider,
    model: (assistantMessage as { model?: string }).model,
    operationName: "chat",
    durationMs,
    ttftMs,
    finishReasons,
    outputMessages: outputMessages.length > 0 ? outputMessages : undefined,
    error,
    errorType: error ? stopReason : undefined,
    callIndex: ctx.state.assistantMessageIndex,
  });
}

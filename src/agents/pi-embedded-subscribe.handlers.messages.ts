import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { createInlineCodeState } from "../markdown/code-spans.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  isMessagingToolDuplicateNormalized,
  normalizeTextForComparison,
} from "./pi-embedded-helpers.js";
import type { BlockReplyPayload } from "./pi-embedded-payloads.js";
import type {
  EmbeddedPiSubscribeContext,
  EmbeddedPiSubscribeState,
} from "./pi-embedded-subscribe.handlers.types.js";
import { appendRawStream } from "./pi-embedded-subscribe.raw-stream.js";
import {
  extractAssistantText,
  extractAssistantTextWithThinkingTags,
  extractAssistantThinking,
  extractThinkingFromTaggedStream,
  extractThinkingFromTaggedText,
  formatReasoningMessage,
  promoteThinkingTagsToBlocks,
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

function isTranscriptOnlyOpenClawAssistantMessage(message: AgentMessage | undefined): boolean {
  if (!message || message.role !== "assistant") {
    return false;
  }
  const provider = typeof message.provider === "string" ? message.provider.trim() : "";
  const model = typeof message.model === "string" ? message.model.trim() : "";
  return provider === "openclaw" && (model === "delivery-mirror" || model === "gateway-injected");
}

function emitReasoningEnd(ctx: EmbeddedPiSubscribeContext) {
  if (!ctx.state.reasoningStreamOpen) {
    return;
  }
  ctx.state.reasoningStreamOpen = false;
  ctx.state.partialBlockState.thinking = false;
  (ctx.state.partialBlockState as { thinkingTransitioned?: boolean }).thinkingTransitioned = false;
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

function clearPendingToolMedia(
  state: Pick<EmbeddedPiSubscribeState, "pendingToolMediaUrls" | "pendingToolAudioAsVoice">,
) {
  state.pendingToolMediaUrls = [];
  state.pendingToolAudioAsVoice = false;
}

export function consumePendingToolMediaIntoReply(
  state: Pick<EmbeddedPiSubscribeState, "pendingToolMediaUrls" | "pendingToolAudioAsVoice">,
  payload: BlockReplyPayload,
): BlockReplyPayload {
  if (payload.isReasoning) {
    return payload;
  }
  if (state.pendingToolMediaUrls.length === 0 && !state.pendingToolAudioAsVoice) {
    return payload;
  }
  const mergedMediaUrls = Array.from(
    new Set([...(payload.mediaUrls ?? []), ...state.pendingToolMediaUrls]),
  );
  const mergedPayload: BlockReplyPayload = {
    ...payload,
    mediaUrls: mergedMediaUrls.length ? mergedMediaUrls : undefined,
    audioAsVoice: payload.audioAsVoice || state.pendingToolAudioAsVoice || undefined,
  };
  clearPendingToolMedia(state);
  return mergedPayload;
}

export function consumePendingToolMediaReply(
  state: Pick<EmbeddedPiSubscribeState, "pendingToolMediaUrls" | "pendingToolAudioAsVoice">,
): BlockReplyPayload | null {
  if (state.pendingToolMediaUrls.length === 0 && !state.pendingToolAudioAsVoice) {
    return null;
  }
  const payload: BlockReplyPayload = {
    mediaUrls: state.pendingToolMediaUrls.length
      ? Array.from(new Set(state.pendingToolMediaUrls))
      : undefined,
    audioAsVoice: state.pendingToolAudioAsVoice || undefined,
  };
  clearPendingToolMedia(state);
  return payload;
}

export function hasAssistantVisibleReply(params: {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  audioAsVoice?: boolean;
}): boolean {
  return resolveSendableOutboundReplyParts(params).hasContent || Boolean(params.audioAsVoice);
}

export function buildAssistantStreamData(params: {
  text?: string;
  delta?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
}): { text: string; delta: string; mediaUrls?: string[] } {
  const mediaUrls = resolveSendableOutboundReplyParts(params).mediaUrls;
  return {
    text: params.text ?? "",
    delta: params.delta ?? "",
    mediaUrls: mediaUrls.length ? mediaUrls : undefined,
  };
}

export function handleMessageStart(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & { message: AgentMessage },
) {
  const msg = evt.message;
  if (msg?.role !== "assistant" || isTranscriptOnlyOpenClawAssistantMessage(msg)) {
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
  if (msg?.role !== "assistant" || isTranscriptOnlyOpenClawAssistantMessage(msg)) {
    return;
  }

  ctx.noteLastAssistant(msg);
  if (ctx.state.deterministicApprovalPromptSent) {
    return;
  }

  const assistantEvent = evt.assistantMessageEvent;
  const assistantRecord =
    assistantEvent && typeof assistantEvent === "object"
      ? (assistantEvent as Record<string, unknown>)
      : undefined;
  const evtType = typeof assistantRecord?.type === "string" ? assistantRecord.type : "";

  if (evtType === "thinking_start" || evtType === "thinking_delta" || evtType === "thinking_end") {
    // Mark that native thinking events are driving the lifecycle, so tagged
    // <think> transitions in text deltas don't duplicate hooks.
    ctx.state.nativeThinkingActive = true;
    if (evtType === "thinking_start" || evtType === "thinking_delta") {
      if (!ctx.state.reasoningStreamOpen) {
        ctx.state.reasoningStreamOpen = true;
        ctx.state.thinkingStartedAt = Date.now();
        // Emit thinking_start hook on first thinking event
        const hookRunner = ctx.hookRunner ?? getGlobalHookRunner();
        if (hookRunner?.hasHooks("thinking_start")) {
          void hookRunner.runThinkingStart(
            { runId: ctx.params.runId },
            {
              agentId: ctx.params.agentId,
              sessionKey: ctx.params.sessionKey,
            },
          );
        }
      }
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
    if (ctx.state.streamReasoning || ctx.params.onAgentEvent) {
      // Prefer full partial-message thinking when available; fall back to event payloads.
      const partialThinking = extractAssistantThinking(msg);
      ctx.emitReasoningStream(partialThinking || thinkingContent || thinkingDelta);
    }
    if (evtType === "thinking_end") {
      // Ensure plugins always get a matching thinking_start before thinking_end
      if (!ctx.state.reasoningStreamOpen) {
        ctx.state.reasoningStreamOpen = true;
        ctx.state.thinkingStartedAt = Date.now();
        const hookRunner = ctx.hookRunner ?? getGlobalHookRunner();
        if (hookRunner?.hasHooks("thinking_start")) {
          void hookRunner.runThinkingStart(
            { runId: ctx.params.runId },
            {
              agentId: ctx.params.agentId,
              sessionKey: ctx.params.sessionKey,
            },
          );
        }
      }
      emitReasoningEnd(ctx);
      // Emit thinking_end hook
      const hookRunner = ctx.hookRunner ?? getGlobalHookRunner();
      if (hookRunner?.hasHooks("thinking_end")) {
        const fullThinking = extractAssistantThinking(msg);
        void hookRunner.runThinkingEnd(
          {
            runId: ctx.params.runId,
            text: fullThinking || thinkingContent || undefined,
            durationMs: ctx.state.thinkingStartedAt
              ? Date.now() - ctx.state.thinkingStartedAt
              : undefined,
          },
          {
            agentId: ctx.params.agentId,
            sessionKey: ctx.params.sessionKey,
          },
        );
      }
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
    ctx.state.deltaBuffer += chunk;
    if (ctx.blockChunker) {
      ctx.blockChunker.append(chunk);
    } else {
      ctx.state.blockBuffer += chunk;
    }
  }

  if (ctx.state.streamReasoning || ctx.params.onAgentEvent) {
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

  // Track <think> tag transitions independently of visible text.
  // stripBlockTags updates partialBlockState as a side effect, so we must
  // call it even when `next` is empty (pure-thinking chunks).
  const wasThinking = ctx.state.partialBlockState.thinking;
  if (!chunk) {
    (ctx.state.partialBlockState as { thinkingTransitioned?: boolean }).thinkingTransitioned =
      false;
  }
  const visibleDelta = chunk ? ctx.stripBlockTags(chunk, ctx.state.partialBlockState) : "";

  // Handle single-chunk transitions: if the chunk contained both <think> and </think>,
  // partialBlockState.thinking ends as false. Detect this by checking whether
  // stripBlockTags consumed any thinking content even though final state is not-thinking.
  const nowThinking = ctx.state.partialBlockState.thinking;
  const enteredThinking = !wasThinking && nowThinking;
  const exitedThinking = wasThinking && !nowThinking;
  // Single-chunk: was not thinking, is not thinking, but stripBlockTags found and consumed
  // a complete thinking block (open+close in one delta). Uses the thinkingTransitioned flag
  // set by stripBlockTags, which correctly respects code-span filtering.
  const singleChunkThinking =
    !wasThinking &&
    !nowThinking &&
    !!(ctx.state.partialBlockState as { thinkingTransitioned?: boolean }).thinkingTransitioned;

  // Skip tagged transitions entirely when native thinking events already manage the lifecycle.
  // This prevents duplicated thinking_start/thinking_end when providers mirror reasoning in
  // both native events and <think> text tags simultaneously.
  const nativeThinkingActive = ctx.state.nativeThinkingActive ?? false;

  if ((enteredThinking || singleChunkThinking) && !nativeThinkingActive) {
    // Only fire tagged thinking_start if native thinking hasn't already opened it
    if (!ctx.state.reasoningStreamOpen) {
      ctx.state.reasoningStreamOpen = true;
      ctx.state.thinkingStartedAt = Date.now();
      // Fire thinking_start hook for <think> tag flows
      const hookRunner = ctx.hookRunner ?? getGlobalHookRunner();
      if (hookRunner?.hasHooks("thinking_start")) {
        void hookRunner.runThinkingStart(
          { runId: ctx.params.runId },
          {
            agentId: ctx.params.agentId,
            sessionKey: ctx.params.sessionKey,
          },
        );
      }
    }
  }
  // Detect when thinking block ends (</think> tag processed)
  if ((exitedThinking || singleChunkThinking) && !nativeThinkingActive) {
    emitReasoningEnd(ctx);
    // Fire thinking_end hook for <think> tag flows
    const hookRunner = ctx.hookRunner ?? getGlobalHookRunner();
    if (hookRunner?.hasHooks("thinking_end")) {
      const fullThinking = extractThinkingFromTaggedText(ctx.state.deltaBuffer);
      void hookRunner.runThinkingEnd(
        {
          runId: ctx.params.runId,
          text: fullThinking || undefined,
          durationMs: ctx.state.thinkingStartedAt
            ? Date.now() - ctx.state.thinkingStartedAt
            : undefined,
        },
        {
          agentId: ctx.params.agentId,
          sessionKey: ctx.params.sessionKey,
        },
      );
    }
  }

  if (next) {
    const parsedDelta = visibleDelta ? ctx.consumePartialReplyDirectives(visibleDelta) : null;
    const parsedFull = parseReplyDirectives(stripTrailingDirective(next));
    const cleanedText = parsedFull.text;
    const { mediaUrls, hasMedia } = resolveSendableOutboundReplyParts(parsedDelta ?? {});
    const hasAudio = Boolean(parsedDelta?.audioAsVoice);
    const previousCleaned = ctx.state.lastStreamedAssistantCleaned ?? "";

    let shouldEmit = false;
    let deltaText = "";
    if (!hasAssistantVisibleReply({ text: cleanedText, mediaUrls, audioAsVoice: hasAudio })) {
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
      const data = buildAssistantStreamData({
        text: cleanedText,
        delta: deltaText,
        mediaUrls,
      });
      emitAgentEvent({
        runId: ctx.params.runId,
        stream: "assistant",
        data,
      });
      void ctx.params.onAgentEvent?.({
        stream: "assistant",
        data,
      });
      ctx.state.emittedAssistantUpdate = true;
      if (ctx.params.onPartialReply && ctx.state.shouldEmitPartialReplies) {
        void ctx.params.onPartialReply(data);
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
  if (msg?.role !== "assistant" || isTranscriptOnlyOpenClawAssistantMessage(msg)) {
    return;
  }

  const assistantMessage = msg;
  ctx.noteLastAssistant(assistantMessage);
  ctx.recordAssistantUsage((assistantMessage as { usage?: unknown }).usage);

  // Safety net: if thinking_start was fired but no thinking_end arrived (provider
  // skipped the explicit end event), close the thinking lifecycle now so plugins
  // don't get stuck with an unclosed thinking indicator.
  if (ctx.state.reasoningStreamOpen) {
    emitReasoningEnd(ctx);
    const hookRunner = ctx.hookRunner ?? getGlobalHookRunner();
    if (hookRunner?.hasHooks("thinking_end")) {
      const fullThinking =
        extractAssistantThinking(msg) ||
        extractThinkingFromTaggedText(extractAssistantTextWithThinkingTags(msg));
      void hookRunner.runThinkingEnd(
        {
          runId: ctx.params.runId,
          text: fullThinking || undefined,
          durationMs: ctx.state.thinkingStartedAt
            ? Date.now() - ctx.state.thinkingStartedAt
            : undefined,
        },
        {
          agentId: ctx.params.agentId,
          sessionKey: ctx.params.sessionKey,
        },
      );
    }
  }

  if (ctx.state.deterministicApprovalPromptSent) {
    return;
  }
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
    ctx.state.includeReasoning || ctx.state.streamReasoning || Boolean(ctx.params.onAgentEvent)
      ? extractAssistantThinking(assistantMessage) || extractThinkingFromTaggedText(rawText)
      : "";
  const formattedReasoning = rawThinking ? formatReasoningMessage(rawThinking) : "";
  const trimmedText = text.trim();
  const parsedText = trimmedText ? parseReplyDirectives(stripTrailingDirective(trimmedText)) : null;
  let cleanedText = parsedText?.text ?? "";
  let { mediaUrls, hasMedia } = resolveSendableOutboundReplyParts(parsedText ?? {});

  if (!cleanedText && !hasMedia && !ctx.params.enforceFinalTag) {
    const rawTrimmed = rawText.trim();
    const rawStrippedFinal = rawTrimmed.replace(/<\s*\/?\s*final\s*>/gi, "").trim();
    const rawCandidate = rawStrippedFinal || rawTrimmed;
    if (rawCandidate) {
      const parsedFallback = parseReplyDirectives(stripTrailingDirective(rawCandidate));
      cleanedText = parsedFallback.text ?? rawCandidate;
      ({ mediaUrls, hasMedia } = resolveSendableOutboundReplyParts(parsedFallback));
    }
  }

  if (!ctx.state.emittedAssistantUpdate && (cleanedText || hasMedia)) {
    const data = buildAssistantStreamData({
      text: cleanedText,
      delta: cleanedText,
      mediaUrls,
    });
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "assistant",
      data,
    });
    void ctx.params.onAgentEvent?.({
      stream: "assistant",
      data,
    });
    ctx.state.emittedAssistantUpdate = true;
  }

  const addedDuringMessage = ctx.state.assistantTexts.length > ctx.state.assistantTextBaseline;
  const chunkerHasBuffered = ctx.blockChunker?.hasBuffered() ?? false;
  ctx.finalizeAssistantTexts({ text, addedDuringMessage, chunkerHasBuffered });

  const onBlockReply = ctx.params.onBlockReply;
  const emitBlockReplySafely = (payload: Parameters<NonNullable<typeof onBlockReply>>[0]) => {
    if (!onBlockReply) {
      return;
    }
    void Promise.resolve()
      .then(() => onBlockReply(payload))
      .catch((err) => {
        ctx.log.warn(`block reply callback failed: ${String(err)}`);
      });
  };
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
    emitBlockReplySafely({ text: formattedReasoning, isReasoning: true });
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
    if (hasAssistantVisibleReply({ text: cleanedText, mediaUrls, audioAsVoice })) {
      ctx.emitBlockReply({
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
  if ((ctx.state.streamReasoning || ctx.params.onAgentEvent) && rawThinking) {
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
  ctx.state.lastStreamedAssistant = undefined;
  ctx.state.lastStreamedAssistantCleaned = undefined;
  ctx.state.reasoningStreamOpen = false;
}

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createStreamingDirectiveAccumulator } from "../auto-reply/reply/streaming-directives.js";
import { formatToolAggregate } from "../auto-reply/tool-meta.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { InlineCodeState } from "../markdown/code-spans.js";
import { buildCodeSpanIndex, createInlineCodeState } from "../markdown/code-spans.js";
import { EmbeddedBlockChunker } from "./pi-embedded-block-chunker.js";
import {
  isMessagingToolDuplicateNormalized,
  normalizeTextForComparison,
} from "./pi-embedded-helpers.js";
import { createEmbeddedPiSessionEventHandler } from "./pi-embedded-subscribe.handlers.js";
import type {
  EmbeddedPiSubscribeContext,
  EmbeddedPiSubscribeState,
} from "./pi-embedded-subscribe.handlers.types.js";
import { resolveMediaArtifactUrls } from "./pi-embedded-subscribe.tools.js";
import type { SubscribeEmbeddedPiSessionParams } from "./pi-embedded-subscribe.types.js";
import { formatReasoningMessage, stripDowngradedToolCallText } from "./pi-embedded-utils.js";
import { hasNonzeroUsage, normalizeUsage, type UsageLike } from "./usage.js";

const THINKING_TAG_SCAN_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
const FINAL_TAG_SCAN_RE = /<\s*(\/?)\s*final\s*>/gi;
const log = createSubsystemLogger("agent/embedded");

export type {
  BlockReplyChunking,
  SubscribeEmbeddedPiSessionParams,
  ToolResultFormat,
} from "./pi-embedded-subscribe.types.js";

export function subscribeEmbeddedPiSession(params: SubscribeEmbeddedPiSessionParams) {
  const reasoningMode = params.reasoningMode ?? "off";
  const toolResultFormat = params.toolResultFormat ?? "markdown";
  const useMarkdown = toolResultFormat === "markdown";
  const state: EmbeddedPiSubscribeState = {
    assistantTexts: [],
    toolMetas: [],
    toolMetaById: new Map(),
    toolSummaryById: new Set(),
    lastToolError: undefined,
    blockReplyBreak: params.blockReplyBreak ?? "text_end",
    reasoningMode,
    includeReasoning: reasoningMode === "on",
    shouldEmitPartialReplies: !(reasoningMode === "on" && !params.onBlockReply),
    streamReasoning: reasoningMode === "stream" && typeof params.onReasoningStream === "function",
    deltaBuffer: "",
    blockBuffer: "",
    // Track if a streamed chunk opened a <think> block (stateful across chunks).
    blockState: { thinking: false, final: false, inlineCode: createInlineCodeState() },
    partialBlockState: { thinking: false, final: false, inlineCode: createInlineCodeState() },
    lastStreamedAssistant: undefined,
    lastStreamedAssistantCleaned: undefined,
    emittedAssistantUpdate: false,
    lastStreamedReasoning: undefined,
    lastBlockReplyText: undefined,
    reasoningStreamOpen: false,
    assistantMessageIndex: 0,
    lastAssistantTextMessageIndex: -1,
    lastAssistantTextNormalized: undefined,
    lastAssistantTextTrimmed: undefined,
    assistantTextBaseline: 0,
    suppressBlockChunks: false, // Avoid late chunk inserts after final text merge.
    lastReasoningSent: undefined,
    compactionInFlight: false,
    pendingCompactionRetry: 0,
    compactionRetryResolve: undefined,
    compactionRetryReject: undefined,
    compactionRetryPromise: null,
    unsubscribed: false,
    messagingToolSentTexts: [],
    messagingToolSentTextsNormalized: [],
    messagingToolSentTargets: [],
    messagingToolSentMediaUrls: [],
    pendingMessagingTexts: new Map(),
    pendingMessagingTargets: new Map(),
    successfulCronAdds: 0,
    pendingMessagingMediaUrls: new Map(),
    deterministicApprovalPromptSent: false,
    pendingMediaArtifacts: [],
  };
  const usageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
  let compactionCount = 0;

  const assistantTexts = state.assistantTexts;
  const toolMetas = state.toolMetas;
  const toolMetaById = state.toolMetaById;
  const toolSummaryById = state.toolSummaryById;
  const messagingToolSentTexts = state.messagingToolSentTexts;
  const messagingToolSentTextsNormalized = state.messagingToolSentTextsNormalized;
  const messagingToolSentTargets = state.messagingToolSentTargets;
  const messagingToolSentMediaUrls = state.messagingToolSentMediaUrls;
  const pendingMessagingTexts = state.pendingMessagingTexts;
  const pendingMessagingTargets = state.pendingMessagingTargets;
  const replyDirectiveAccumulator = createStreamingDirectiveAccumulator();
  const partialReplyDirectiveAccumulator = createStreamingDirectiveAccumulator();
  const emitBlockReplySafely = (
    payload: Parameters<NonNullable<SubscribeEmbeddedPiSessionParams["onBlockReply"]>>[0],
  ) => {
    if (!params.onBlockReply) {
      return;
    }
    void Promise.resolve()
      .then(() => params.onBlockReply?.(payload))
      .catch((err) => {
        log.warn(`block reply callback failed: ${String(err)}`);
      });
  };

  const resetAssistantMessageState = (nextAssistantTextBaseline: number) => {
    state.deltaBuffer = "";
    state.blockBuffer = "";
    blockChunker?.reset();
    replyDirectiveAccumulator.reset();
    partialReplyDirectiveAccumulator.reset();
    state.blockState.thinking = false;
    state.blockState.final = false;
    state.blockState.inlineCode = createInlineCodeState();
    state.partialBlockState.thinking = false;
    state.partialBlockState.final = false;
    state.partialBlockState.inlineCode = createInlineCodeState();
    state.lastStreamedAssistant = undefined;
    state.lastStreamedAssistantCleaned = undefined;
    state.emittedAssistantUpdate = false;
    state.lastBlockReplyText = undefined;
    state.lastStreamedReasoning = undefined;
    state.lastReasoningSent = undefined;
    state.reasoningStreamOpen = false;
    state.suppressBlockChunks = false;
    state.assistantMessageIndex += 1;
    state.lastAssistantTextMessageIndex = -1;
    state.lastAssistantTextNormalized = undefined;
    state.lastAssistantTextTrimmed = undefined;
    state.assistantTextBaseline = nextAssistantTextBaseline;
  };

  const rememberAssistantText = (text: string) => {
    state.lastAssistantTextMessageIndex = state.assistantMessageIndex;
    state.lastAssistantTextTrimmed = text.trimEnd();
    const normalized = normalizeTextForComparison(text);
    state.lastAssistantTextNormalized = normalized.length > 0 ? normalized : undefined;
  };

  const shouldSkipAssistantText = (text: string) => {
    if (state.lastAssistantTextMessageIndex !== state.assistantMessageIndex) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (trimmed && trimmed === state.lastAssistantTextTrimmed) {
      return true;
    }
    const normalized = normalizeTextForComparison(text);
    if (normalized.length > 0 && normalized === state.lastAssistantTextNormalized) {
      return true;
    }
    return false;
  };

  const pushAssistantText = (text: string) => {
    if (!text) {
      return;
    }
    if (shouldSkipAssistantText(text)) {
      return;
    }
    assistantTexts.push(text);
    rememberAssistantText(text);
  };

  const finalizeAssistantTexts = (args: {
    text: string;
    addedDuringMessage: boolean;
    chunkerHasBuffered: boolean;
  }) => {
    const { text, addedDuringMessage, chunkerHasBuffered } = args;

    // If we're not streaming block replies, ensure the final payload includes
    // the final text even when interim streaming was enabled.
    if (state.includeReasoning && text && !params.onBlockReply) {
      if (assistantTexts.length > state.assistantTextBaseline) {
        assistantTexts.splice(
          state.assistantTextBaseline,
          assistantTexts.length - state.assistantTextBaseline,
          text,
        );
        rememberAssistantText(text);
      } else {
        pushAssistantText(text);
      }
      state.suppressBlockChunks = true;
    } else if (!addedDuringMessage && !chunkerHasBuffered && text) {
      // Non-streaming models (no text_delta): ensure assistantTexts gets the final
      // text when the chunker has nothing buffered to drain.
      pushAssistantText(text);
    }

    state.assistantTextBaseline = assistantTexts.length;
  };

  // ── Messaging tool duplicate detection ──────────────────────────────────────
  // Track texts sent via messaging tools to suppress duplicate block replies.
  // Only committed (successful) texts are checked - pending texts are tracked
  // to support commit logic but not used for suppression (avoiding lost messages on tool failure).
  // These tools can send messages via sendMessage/threadReply actions (or sessions_send with message).
  const MAX_MESSAGING_SENT_TEXTS = 200;
  const MAX_MESSAGING_SENT_TARGETS = 200;
  const MAX_MESSAGING_SENT_MEDIA_URLS = 200;
  const trimMessagingToolSent = () => {
    if (messagingToolSentTexts.length > MAX_MESSAGING_SENT_TEXTS) {
      const overflow = messagingToolSentTexts.length - MAX_MESSAGING_SENT_TEXTS;
      messagingToolSentTexts.splice(0, overflow);
      messagingToolSentTextsNormalized.splice(0, overflow);
    }
    if (messagingToolSentTargets.length > MAX_MESSAGING_SENT_TARGETS) {
      const overflow = messagingToolSentTargets.length - MAX_MESSAGING_SENT_TARGETS;
      messagingToolSentTargets.splice(0, overflow);
    }
    if (messagingToolSentMediaUrls.length > MAX_MESSAGING_SENT_MEDIA_URLS) {
      const overflow = messagingToolSentMediaUrls.length - MAX_MESSAGING_SENT_MEDIA_URLS;
      messagingToolSentMediaUrls.splice(0, overflow);
    }
  };

  const ensureCompactionPromise = () => {
    if (!state.compactionRetryPromise) {
      // Create a single promise that resolves when ALL pending compactions complete
      // (tracked by pendingCompactionRetry counter, decremented in resolveCompactionRetry)
      state.compactionRetryPromise = new Promise((resolve, reject) => {
        state.compactionRetryResolve = resolve;
        state.compactionRetryReject = reject;
      });
      // Prevent unhandled rejection if rejected after all consumers have resolved
      state.compactionRetryPromise.catch((err) => {
        log.debug(`compaction promise rejected (no waiter): ${String(err)}`);
      });
    }
  };

  const noteCompactionRetry = () => {
    state.pendingCompactionRetry += 1;
    ensureCompactionPromise();
  };

  const resolveCompactionRetry = () => {
    if (state.pendingCompactionRetry <= 0) {
      return;
    }
    state.pendingCompactionRetry -= 1;
    if (state.pendingCompactionRetry === 0 && !state.compactionInFlight) {
      state.compactionRetryResolve?.();
      state.compactionRetryResolve = undefined;
      state.compactionRetryReject = undefined;
      state.compactionRetryPromise = null;
    }
  };

  const maybeResolveCompactionWait = () => {
    if (state.pendingCompactionRetry === 0 && !state.compactionInFlight) {
      state.compactionRetryResolve?.();
      state.compactionRetryResolve = undefined;
      state.compactionRetryReject = undefined;
      state.compactionRetryPromise = null;
    }
  };
  const recordAssistantUsage = (usageLike: unknown) => {
    const usage = normalizeUsage((usageLike ?? undefined) as UsageLike | undefined);
    if (!hasNonzeroUsage(usage)) {
      return;
    }
    usageTotals.input += usage.input ?? 0;
    usageTotals.output += usage.output ?? 0;
    usageTotals.cacheRead += usage.cacheRead ?? 0;
    usageTotals.cacheWrite += usage.cacheWrite ?? 0;
    const usageTotal =
      usage.total ??
      (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    usageTotals.total += usageTotal;
  };
  const getUsageTotals = () => {
    const hasUsage =
      usageTotals.input > 0 ||
      usageTotals.output > 0 ||
      usageTotals.cacheRead > 0 ||
      usageTotals.cacheWrite > 0 ||
      usageTotals.total > 0;
    if (!hasUsage) {
      return undefined;
    }
    const derivedTotal =
      usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite;
    return {
      input: usageTotals.input || undefined,
      output: usageTotals.output || undefined,
      cacheRead: usageTotals.cacheRead || undefined,
      cacheWrite: usageTotals.cacheWrite || undefined,
      total: usageTotals.total || derivedTotal || undefined,
    };
  };
  const incrementCompactionCount = () => {
    compactionCount += 1;
  };

  const blockChunking = params.blockReplyChunking;
  const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
  // KNOWN: Provider streams are not strictly once-only or perfectly ordered.
  // `text_end` can repeat full content; late `text_end` can arrive after `message_end`.
  // Tests: `src/agents/pi-embedded-subscribe.test.ts` (e.g. late text_end cases).
  const shouldEmitToolResult = () =>
    typeof params.shouldEmitToolResult === "function"
      ? params.shouldEmitToolResult()
      : params.verboseLevel === "on" || params.verboseLevel === "full";
  const shouldEmitToolOutput = () =>
    typeof params.shouldEmitToolOutput === "function"
      ? params.shouldEmitToolOutput()
      : params.verboseLevel === "full";
  const formatToolOutputBlock = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return "(no output)";
    }
    if (!useMarkdown) {
      return trimmed;
    }
    return `\`\`\`txt\n${trimmed}\n\`\`\``;
  };
  const emitToolResultMessage = (message: string) => {
    if (!params.onToolResult) {
      return;
    }
    const cleanedText = message.trim();
    if (!cleanedText) {
      return;
    }
    try {
      void params.onToolResult({
        text: cleanedText,
      });
    } catch {
      // ignore tool result delivery failures
    }
  };
  const emitToolSummary = (toolName?: string, meta?: string) => {
    const agg = formatToolAggregate(toolName, meta ? [meta] : undefined, {
      markdown: useMarkdown,
    });
    emitToolResultMessage(agg);
  };
  const emitToolOutput = (toolName?: string, meta?: string, output?: string) => {
    if (!output) {
      return;
    }
    const agg = formatToolAggregate(toolName, meta ? [meta] : undefined, {
      markdown: useMarkdown,
    });
    const message = `${agg}\n${formatToolOutputBlock(output)}`;
    emitToolResultMessage(message);
  };

  const stripBlockTags = (
    text: string,
    state: { thinking: boolean; final: boolean; inlineCode?: InlineCodeState },
  ): string => {
    if (!text) {
      return text;
    }

    const inlineStateStart = state.inlineCode ?? createInlineCodeState();
    const codeSpans = buildCodeSpanIndex(text, inlineStateStart);

    // 1. Handle <think> blocks (stateful, strip content inside)
    let processed = "";
    THINKING_TAG_SCAN_RE.lastIndex = 0;
    let lastIndex = 0;
    let inThinking = state.thinking;
    for (const match of text.matchAll(THINKING_TAG_SCAN_RE)) {
      const idx = match.index ?? 0;
      if (codeSpans.isInside(idx)) {
        continue;
      }
      if (!inThinking) {
        processed += text.slice(lastIndex, idx);
      }
      const isClose = match[1] === "/";
      inThinking = !isClose;
      lastIndex = idx + match[0].length;
    }
    if (!inThinking) {
      processed += text.slice(lastIndex);
    }
    state.thinking = inThinking;

    // 2. Handle <final> blocks (stateful, strip content OUTSIDE)
    // If enforcement is disabled, we still strip the tags themselves to prevent
    // hallucinations (e.g. Minimax copying the style) from leaking, but we
    // do not enforce buffering/extraction logic.
    const finalCodeSpans = buildCodeSpanIndex(processed, inlineStateStart);
    if (!params.enforceFinalTag) {
      state.inlineCode = finalCodeSpans.inlineState;
      FINAL_TAG_SCAN_RE.lastIndex = 0;
      return stripTagsOutsideCodeSpans(processed, FINAL_TAG_SCAN_RE, finalCodeSpans.isInside);
    }

    // If enforcement is enabled, only return text that appeared inside a <final> block.
    let result = "";
    FINAL_TAG_SCAN_RE.lastIndex = 0;
    let lastFinalIndex = 0;
    let inFinal = state.final;
    let everInFinal = state.final;

    for (const match of processed.matchAll(FINAL_TAG_SCAN_RE)) {
      const idx = match.index ?? 0;
      if (finalCodeSpans.isInside(idx)) {
        continue;
      }
      const isClose = match[1] === "/";

      if (!inFinal && !isClose) {
        // Found <final> start tag.
        inFinal = true;
        everInFinal = true;
        lastFinalIndex = idx + match[0].length;
      } else if (inFinal && isClose) {
        // Found </final> end tag.
        result += processed.slice(lastFinalIndex, idx);
        inFinal = false;
        lastFinalIndex = idx + match[0].length;
      }
    }

    if (inFinal) {
      result += processed.slice(lastFinalIndex);
    }
    state.final = inFinal;

    // Strict Mode: If enforcing final tags, we MUST NOT return content unless
    // we have seen a <final> tag. Otherwise, we leak "thinking out loud" text
    // (e.g. "**Locating Manulife**...") that the model emitted without <think> tags.
    if (!everInFinal) {
      return "";
    }

    // Hardened Cleanup: Remove any remaining <final> tags that might have been
    // missed (e.g. nested tags or hallucinations) to prevent leakage.
    const resultCodeSpans = buildCodeSpanIndex(result, inlineStateStart);
    state.inlineCode = resultCodeSpans.inlineState;
    return stripTagsOutsideCodeSpans(result, FINAL_TAG_SCAN_RE, resultCodeSpans.isInside);
  };

  const stripTagsOutsideCodeSpans = (
    text: string,
    pattern: RegExp,
    isInside: (index: number) => boolean,
  ) => {
    let output = "";
    let lastIndex = 0;
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const idx = match.index ?? 0;
      if (isInside(idx)) {
        continue;
      }
      output += text.slice(lastIndex, idx);
      lastIndex = idx + match[0].length;
    }
    output += text.slice(lastIndex);
    return output;
  };

  /** Drain all pending media artifacts and clear the buffer. */
  const drainPendingMediaArtifacts = (): {
    mediaUrls: string[];
    voiceMediaUrls: string[];
    audioAsVoice: boolean;
  } => {
    const mediaUrls: string[] = [];
    const voiceMediaUrls: string[] = [];
    let audioAsVoice = false;
    for (const { artifact } of state.pendingMediaArtifacts) {
      const urls = resolveMediaArtifactUrls(artifact);
      if (artifact.audioAsVoice) {
        voiceMediaUrls.push(...urls);
        audioAsVoice = true;
      } else {
        mediaUrls.push(...urls);
      }
    }
    state.pendingMediaArtifacts.length = 0;
    return { mediaUrls, voiceMediaUrls, audioAsVoice };
  };

  const emitBlockChunk = (text: string) => {
    if (state.suppressBlockChunks) {
      return;
    }
    // Strip <think> and <final> blocks across chunk boundaries to avoid leaking reasoning.
    // Also strip downgraded tool call text ([Tool Call: ...], [Historical context: ...], etc.).
    const chunk = stripDowngradedToolCallText(stripBlockTags(text, state.blockState)).trimEnd();
    if (!chunk) {
      return;
    }
    if (chunk === state.lastBlockReplyText) {
      return;
    }

    // Only check committed (successful) messaging tool texts - checking pending texts
    // is risky because if the tool fails after suppression, the user gets no response
    const normalizedChunk = normalizeTextForComparison(chunk);
    if (isMessagingToolDuplicateNormalized(normalizedChunk, messagingToolSentTextsNormalized)) {
      log.debug(`Skipping block reply - already sent via messaging tool: ${chunk.slice(0, 50)}...`);
      return;
    }

    if (shouldSkipAssistantText(chunk)) {
      return;
    }

    state.lastBlockReplyText = chunk;
    assistantTexts.push(chunk);
    rememberAssistantText(chunk);
    if (!params.onBlockReply) {
      return;
    }
    const splitResult = replyDirectiveAccumulator.consume(chunk);
    if (!splitResult) {
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

    // Drain pending media artifacts from tool results and attach to this block reply.
    const drained = drainPendingMediaArtifacts();
    const mergedMediaUrls = [...(mediaUrls ?? []), ...drained.mediaUrls];
    const audioAsVoiceFromDirectives = audioAsVoice;
    const voiceMediaUrls = drained.voiceMediaUrls;

    // Skip empty payloads, but always emit if audioAsVoice is set (to propagate the flag)
    if (
      !cleanedText &&
      mergedMediaUrls.length === 0 &&
      voiceMediaUrls.length === 0 &&
      !audioAsVoiceFromDirectives &&
      !drained.audioAsVoice
    ) {
      return;
    }
    const shouldEmitStandard =
      Boolean(cleanedText) || mergedMediaUrls.length > 0 || audioAsVoiceFromDirectives;
    if (shouldEmitStandard) {
      emitBlockReplySafely({
        text: cleanedText,
        mediaUrls: mergedMediaUrls.length > 0 ? mergedMediaUrls : undefined,
        audioAsVoice: audioAsVoiceFromDirectives,
        replyToId,
        replyToTag,
        replyToCurrent,
      });
    }
    if (voiceMediaUrls.length > 0 || drained.audioAsVoice) {
      emitBlockReplySafely({
        text: shouldEmitStandard ? undefined : cleanedText,
        mediaUrls: voiceMediaUrls.length > 0 ? voiceMediaUrls : undefined,
        audioAsVoice: true,
        replyToId,
        replyToTag,
        replyToCurrent,
      });
    }
  };

  const consumeReplyDirectives = (text: string, options?: { final?: boolean }) =>
    replyDirectiveAccumulator.consume(text, options);
  const consumePartialReplyDirectives = (text: string, options?: { final?: boolean }) =>
    partialReplyDirectiveAccumulator.consume(text, options);

  const flushBlockReplyBuffer = (opts?: { drainOrphanedArtifacts?: boolean }) => {
    if (!params.onBlockReply) {
      return;
    }
    if (blockChunker?.hasBuffered()) {
      blockChunker.drain({ force: true, emit: emitBlockChunk });
      blockChunker.reset();
    } else if (state.blockBuffer.length > 0) {
      emitBlockChunk(state.blockBuffer);
      state.blockBuffer = "";
    }

    // Only drain orphaned artifacts at terminal points (agent end), not before
    // tool executions or message resets where later text may still attach them.
    if (opts?.drainOrphanedArtifacts && state.pendingMediaArtifacts.length > 0) {
      const {
        mediaUrls: artifactMediaUrls,
        voiceMediaUrls: artifactVoiceMediaUrls,
        audioAsVoice: artifactAudioAsVoice,
      } = drainPendingMediaArtifacts();
      if (artifactMediaUrls.length > 0) {
        emitBlockReplySafely({
          mediaUrls: artifactMediaUrls,
        });
      }
      if (artifactVoiceMediaUrls.length > 0 || artifactAudioAsVoice) {
        emitBlockReplySafely({
          mediaUrls: artifactVoiceMediaUrls.length > 0 ? artifactVoiceMediaUrls : undefined,
          audioAsVoice: true,
        });
      }
    }
  };

  const emitReasoningStream = (text: string) => {
    if (!state.streamReasoning || !params.onReasoningStream) {
      return;
    }
    const formatted = formatReasoningMessage(text);
    if (!formatted) {
      return;
    }
    if (formatted === state.lastStreamedReasoning) {
      return;
    }
    // Compute delta: new text since the last emitted reasoning.
    // Guard against non-prefix changes (e.g. trim/format altering earlier content).
    const prior = state.lastStreamedReasoning ?? "";
    const delta = formatted.startsWith(prior) ? formatted.slice(prior.length) : formatted;
    state.lastStreamedReasoning = formatted;

    // Broadcast thinking event to WebSocket clients in real-time
    emitAgentEvent({
      runId: params.runId,
      stream: "thinking",
      data: {
        text: formatted,
        delta,
      },
    });

    void params.onReasoningStream({
      text: formatted,
    });
  };

  const resetForCompactionRetry = () => {
    assistantTexts.length = 0;
    toolMetas.length = 0;
    toolMetaById.clear();
    toolSummaryById.clear();
    state.lastToolError = undefined;
    messagingToolSentTexts.length = 0;
    messagingToolSentTextsNormalized.length = 0;
    messagingToolSentTargets.length = 0;
    messagingToolSentMediaUrls.length = 0;
    pendingMessagingTexts.clear();
    pendingMessagingTargets.clear();
    state.successfulCronAdds = 0;
    state.pendingMessagingMediaUrls.clear();
    state.deterministicApprovalPromptSent = false;
    state.pendingMediaArtifacts.length = 0;
    resetAssistantMessageState(0);
  };

  const noteLastAssistant = (msg: AgentMessage) => {
    if (msg?.role === "assistant") {
      state.lastAssistant = msg;
    }
  };

  const ctx: EmbeddedPiSubscribeContext = {
    params,
    state,
    log,
    blockChunking,
    blockChunker,
    hookRunner: params.hookRunner,
    noteLastAssistant,
    shouldEmitToolResult,
    shouldEmitToolOutput,
    emitToolSummary,
    emitToolOutput,
    stripBlockTags,
    emitBlockChunk,
    flushBlockReplyBuffer,
    emitReasoningStream,
    consumeReplyDirectives,
    consumePartialReplyDirectives,
    resetAssistantMessageState,
    resetForCompactionRetry,
    finalizeAssistantTexts,
    drainPendingMediaArtifacts,
    trimMessagingToolSent,
    ensureCompactionPromise,
    noteCompactionRetry,
    resolveCompactionRetry,
    maybeResolveCompactionWait,
    recordAssistantUsage,
    incrementCompactionCount,
    getUsageTotals,
    getCompactionCount: () => compactionCount,
  };

  const sessionUnsubscribe = params.session.subscribe(createEmbeddedPiSessionEventHandler(ctx));

  const unsubscribe = () => {
    if (state.unsubscribed) {
      return;
    }
    // Mark as unsubscribed FIRST to prevent waitForCompactionRetry from creating
    // new un-resolvable promises during teardown.
    state.unsubscribed = true;
    // Reject pending compaction wait to unblock awaiting code.
    // Don't resolve, as that would incorrectly signal "compaction complete" when it's still in-flight.
    if (state.compactionRetryPromise) {
      log.debug(`unsubscribe: rejecting compaction wait runId=${params.runId}`);
      const reject = state.compactionRetryReject;
      state.compactionRetryResolve = undefined;
      state.compactionRetryReject = undefined;
      state.compactionRetryPromise = null;
      // Reject with AbortError so it's caught by isAbortError() check in cleanup paths
      const abortErr = new Error("Unsubscribed during compaction");
      abortErr.name = "AbortError";
      reject?.(abortErr);
    }
    // Cancel any in-flight compaction to prevent resource leaks when unsubscribing.
    // Only abort if compaction is actually running to avoid unnecessary work.
    if (params.session.isCompacting) {
      log.debug(`unsubscribe: aborting in-flight compaction runId=${params.runId}`);
      try {
        params.session.abortCompaction();
      } catch (err) {
        log.warn(`unsubscribe: compaction abort failed runId=${params.runId} err=${String(err)}`);
      }
    }
    sessionUnsubscribe();
  };

  return {
    assistantTexts,
    toolMetas,
    unsubscribe,
    isCompacting: () => state.compactionInFlight || state.pendingCompactionRetry > 0,
    isCompactionInFlight: () => state.compactionInFlight,
    getMessagingToolSentTexts: () => messagingToolSentTexts.slice(),
    getMessagingToolSentMediaUrls: () => messagingToolSentMediaUrls.slice(),
    getMessagingToolSentTargets: () => messagingToolSentTargets.slice(),
    getSuccessfulCronAdds: () => state.successfulCronAdds,
    // Returns true if any messaging tool successfully sent a message.
    // Used to suppress agent's confirmation text (e.g., "Respondi no Telegram!")
    // which is generated AFTER the tool sends the actual answer.
    didSendViaMessagingTool: () => messagingToolSentTexts.length > 0,
    didSendDeterministicApprovalPrompt: () => state.deterministicApprovalPromptSent,
    getLastToolError: () => (state.lastToolError ? { ...state.lastToolError } : undefined),
    getUsageTotals,
    getCompactionCount: () => compactionCount,
    waitForCompactionRetry: () => {
      // Reject after unsubscribe so callers treat it as cancellation, not success
      if (state.unsubscribed) {
        const err = new Error("Unsubscribed during compaction wait");
        err.name = "AbortError";
        return Promise.reject(err);
      }
      if (state.compactionInFlight || state.pendingCompactionRetry > 0) {
        ensureCompactionPromise();
        return state.compactionRetryPromise ?? Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        queueMicrotask(() => {
          if (state.unsubscribed) {
            const err = new Error("Unsubscribed during compaction wait");
            err.name = "AbortError";
            reject(err);
            return;
          }
          if (state.compactionInFlight || state.pendingCompactionRetry > 0) {
            ensureCompactionPromise();
            void (state.compactionRetryPromise ?? Promise.resolve()).then(resolve, reject);
          } else {
            resolve();
          }
        });
      });
    },
  };
}

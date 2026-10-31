import { randomUUID } from "node:crypto";
import type { InlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import {
  buildCodeSpanIndex,
  createInlineCodeState,
} from "../../packages/markdown-core/src/code-spans.js";
import type { FenceScanState } from "../../packages/markdown-core/src/fences.js";
import { parseReasoningTagAt } from "../../packages/markdown-core/src/reasoning-tag-parser.js";
import {
  addReplyPayloadMediaFailures,
  appendReplyMediaFailures,
} from "../auto-reply/reply-payload.js";
import type { ReplyDirectiveParseResult } from "../auto-reply/reply/reply-directives.js";
import { createStreamingDirectiveAccumulator } from "../auto-reply/reply/streaming-directives.js";
import {
  emitAgentEventWithAssistantSourceIfCurrent,
  readAgentAssistantSource,
} from "../infra/agent-events.js";
import { findFinalTagMatches } from "../shared/text/final-tags.js";
import { hasOrphanReasoningCloseBoundary } from "../shared/text/reasoning-tags.js";
import { trimTextPreservingCode } from "../shared/text/text-projection.js";
import type { BlockChunkMetadata } from "./embedded-agent-block-chunker.js";
import {
  isMessagingToolDuplicateNormalized,
  normalizeTextForComparison,
} from "./embedded-agent-helpers/messaging-dedupe.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import {
  shouldSuppressSourceReplyOutput,
  shouldSuppressDeterministicApprovalOutput,
} from "./embedded-agent-subscribe.handlers.messages.stream.js";
import type {
  EmbeddedAgentSubscribeContext,
  StreamBlockState,
} from "./embedded-agent-subscribe.handlers.types.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";
import {
  createAssistantThinkingStream,
  createAssistantStreamBlockState,
  createThinkingTagStreamState,
} from "./embedded-agent-utils.js";

function isPotentialTrailingFinalTagFragment(fragment: string): boolean {
  if (!fragment.startsWith("<") || fragment.includes(">")) {
    return false;
  }
  const body = fragment.toLowerCase().slice(1).trimStart().replace(/^\//, "").trimStart();
  if (!body) {
    return true;
  }
  const namePart = body.split(/[\s/>]/, 1)[0] ?? "";
  if (!namePart) {
    return true;
  }
  return "final".startsWith(namePart);
}

function splitTrailingBlockTagFragment(
  text: string,
  isInsideCodeSpan: (index: number) => boolean,
): { text: string; pendingTagFragment?: string } {
  for (let cursor = 0; cursor < text.length;) {
    const start = text.indexOf("<", cursor);
    if (start === -1) {
      break;
    }
    cursor = start + 1;
    if (isInsideCodeSpan(start)) {
      continue;
    }
    const parsed = parseReasoningTagAt(text, start, false);
    if (parsed.kind === "pending") {
      return { text: text.slice(0, start), pendingTagFragment: text.slice(start) };
    }
    if (parsed.kind === "tag") {
      cursor = start + parsed.tag.text.length;
    }
  }
  const fragmentStart = text.lastIndexOf("<");
  if (fragmentStart === -1 || isInsideCodeSpan(fragmentStart)) {
    return { text };
  }
  const fragment = text.slice(fragmentStart);
  if (!isPotentialTrailingFinalTagFragment(fragment)) {
    return { text };
  }
  return {
    text: text.slice(0, fragmentStart),
    pendingTagFragment: fragment,
  };
}

function splitTrailingFenceFragment(
  text: string,
  startsAtLineStart: boolean,
): { text: string; pendingFenceFragment?: string } {
  const lineStart = text.lastIndexOf("\n") + 1;
  const line = text.slice(lineStart);
  if ((!startsAtLineStart && lineStart === 0) || !/^(?: {0,3})(?:`+|~+)$/.test(line)) {
    return { text };
  }
  return {
    text: text.slice(0, lineStart),
    pendingFenceFragment: line,
  };
}

type StreamRenderingParams = {
  params: SubscribeEmbeddedAgentSessionParams;
  state: EmbeddedAgentSubscribeContext["state"];
  log: EmbeddedAgentSubscribeContext["log"];
  blockChunker: EmbeddedAgentSubscribeContext["blockChunker"];
  emitBlockReply: EmbeddedAgentSubscribeContext["emitBlockReply"];
  flushAssistantStream: EmbeddedAgentSubscribeContext["flushAssistantStream"];
  pendingBlockReplyTasks: Set<Promise<void>>;
  pushAssistantText: (text: string, normalizedText?: string) => void;
  shouldSkipAssistantText: (text: string, normalizedText?: string) => boolean;
};

export function createStreamRendering({
  params,
  state,
  log,
  blockChunker,
  emitBlockReply,
  flushAssistantStream,
  pendingBlockReplyTasks,
  pushAssistantText,
  shouldSkipAssistantText,
}: StreamRenderingParams) {
  const messagingToolSentTextsNormalized = state.messagingToolSentTextsNormalized;
  const partialReplyDirectiveAccumulator = createStreamingDirectiveAccumulator();
  let reasoningProjection = createAssistantThinkingStream();
  const coveredBlockSources = new Map<
    number,
    Array<{ range: readonly [number, number]; text: string }>
  >();

  const stripBlockTags = (
    text: string,
    stateLocal: StreamBlockState,
    options?: { final?: boolean },
  ): string => {
    const input = `${stateLocal.pendingFenceFragment ?? ""}${stateLocal.pendingTagFragment ?? ""}${text}`;
    stateLocal.pendingFenceFragment = undefined;
    stateLocal.pendingTagFragment = undefined;
    if (!input) {
      return text;
    }

    const { text: fenceInput, pendingFenceFragment } = options?.final
      ? { text: input, pendingFenceFragment: undefined }
      : splitTrailingFenceFragment(input, stateLocal.fence?.atLineStart ?? true);
    stateLocal.pendingFenceFragment = pendingFenceFragment;
    if (!fenceInput) {
      return "";
    }

    const inlineStateStart = stateLocal.inlineCode ?? createInlineCodeState();
    const fenceStateStart = stateLocal.fence;
    const initialCodeSpans = buildCodeSpanIndex(fenceInput, inlineStateStart, fenceStateStart);
    const { text: scanText, pendingTagFragment } = options?.final
      ? { text: fenceInput, pendingTagFragment: undefined }
      : splitTrailingBlockTagFragment(fenceInput, initialCodeSpans.isInside);
    stateLocal.pendingTagFragment = pendingTagFragment;
    if (!scanText) {
      return "";
    }
    const codeSpans =
      scanText === fenceInput
        ? initialCodeSpans
        : buildCodeSpanIndex(scanText, inlineStateStart, fenceStateStart);

    let processed = "";
    let lastIndex = 0;
    let lastCodeIndex = 0;
    let reasoningDepth = stateLocal.reasoningDepth;
    // Hidden reasoning has its own code state: malformed hidden fences must not
    // mark later visible text as code, but literal close tags there stay hidden.
    let hiddenInlineState: InlineCodeState = stateLocal.reasoningInlineCode
      ? { ...stateLocal.reasoningInlineCode }
      : createInlineCodeState();
    let hiddenFenceState: FenceScanState | undefined = stateLocal.reasoningFence?.open
      ? {
          atLineStart: stateLocal.reasoningFence.atLineStart,
          open: { ...stateLocal.reasoningFence.open },
        }
      : stateLocal.reasoningFence
        ? { atLineStart: stateLocal.reasoningFence.atLineStart }
        : undefined;
    let hiddenPendingFenceFragment = stateLocal.reasoningPendingFenceFragment;
    stateLocal.reasoningPendingFenceFragment = undefined;
    const advanceHiddenCodeState = (segment: string) => {
      const hiddenInput = `${hiddenPendingFenceFragment ?? ""}${segment}`;
      hiddenPendingFenceFragment = undefined;
      if (!hiddenInput) {
        return;
      }
      const { text: hiddenFenceInput, pendingFenceFragment: pendingFenceFragmentLocal } =
        options?.final
          ? { text: hiddenInput, pendingFenceFragment: undefined }
          : splitTrailingFenceFragment(hiddenInput, hiddenFenceState?.atLineStart ?? true);
      hiddenPendingFenceFragment = pendingFenceFragmentLocal;
      if (!hiddenFenceInput) {
        return;
      }
      const next = buildCodeSpanIndex(hiddenFenceInput, hiddenInlineState, hiddenFenceState);
      hiddenInlineState = next.inlineState;
      hiddenFenceState = next.fenceState;
    };
    for (let cursor = 0; cursor < scanText.length;) {
      const idx = scanText.indexOf("<", cursor);
      if (idx === -1) {
        break;
      }
      cursor = idx + 1;
      if (reasoningDepth > 0) {
        advanceHiddenCodeState(scanText.slice(lastCodeIndex, idx));
      }
      const isInsideHiddenCode =
        reasoningDepth > 0 && (hiddenInlineState.open || Boolean(hiddenFenceState?.open));
      lastCodeIndex = idx;
      if ((reasoningDepth === 0 && codeSpans.isInside(idx)) || isInsideHiddenCode) {
        continue;
      }
      // Code ownership comes first: quotes inside literal tags must not consume
      // later real tags when the canonical parser scans their attributes.
      const parsed = parseReasoningTagAt(scanText, idx, true);
      if (parsed.kind !== "tag") {
        continue;
      }
      const match = parsed.tag;
      const isClose = match.isClose;
      cursor = idx + match.text.length;
      lastCodeIndex = cursor;
      if (match.isSelfClosing) {
        if (reasoningDepth === 0) {
          processed += scanText.slice(lastIndex, idx);
        }
        lastIndex = cursor;
        continue;
      }
      if (reasoningDepth === 0) {
        if (isClose) {
          const afterIndex = cursor;
          const before = scanText.slice(lastIndex, idx);
          const after = scanText.slice(afterIndex);
          if (hasOrphanReasoningCloseBoundary({ before, after })) {
            processed = "";
          } else {
            processed += before;
          }
          lastIndex = afterIndex;
          continue;
        }
        processed += scanText.slice(lastIndex, idx);
      }
      // Like the canonical reducer, only the outer close releases hidden text.
      reasoningDepth += isClose ? -1 : 1;
      if (reasoningDepth === 1 && !isClose) {
        hiddenInlineState = createInlineCodeState();
        hiddenFenceState = undefined;
        hiddenPendingFenceFragment = undefined;
      }
      lastIndex = cursor;
    }
    if (reasoningDepth > 0) {
      advanceHiddenCodeState(scanText.slice(lastCodeIndex));
    }
    if (reasoningDepth === 0) {
      processed += scanText.slice(lastIndex);
    }
    stateLocal.reasoningDepth = reasoningDepth;
    stateLocal.reasoningInlineCode = reasoningDepth > 0 ? hiddenInlineState : undefined;
    stateLocal.reasoningFence = reasoningDepth > 0 ? hiddenFenceState : undefined;
    stateLocal.reasoningPendingFenceFragment =
      reasoningDepth > 0 ? hiddenPendingFenceFragment : undefined;

    // Even without enforcement, strip provider-emitted tags from visible text.
    const finalCodeSpans =
      processed === scanText
        ? codeSpans
        : buildCodeSpanIndex(processed, inlineStateStart, fenceStateStart);
    if (!params.enforceFinalTag) {
      stateLocal.inlineCode = finalCodeSpans.inlineState;
      stateLocal.fence = finalCodeSpans.fenceState;
      return stripFinalTagsOutsideCodeSpans(processed, finalCodeSpans.isInside);
    }

    let result = "";
    let lastFinalIndex = 0;
    let inFinal = stateLocal.final;
    let everInFinal = stateLocal.final;

    for (const match of findFinalTagMatches(processed)) {
      const idx = match.index;
      if (finalCodeSpans.isInside(idx)) {
        continue;
      }
      const isClose = match.isClose;
      const isSelfClosing = match.isSelfClosing;

      if (inFinal && (isSelfClosing || isClose)) {
        result += processed.slice(lastFinalIndex, idx);
        inFinal = false;
      } else if (!inFinal && (isSelfClosing || !isClose)) {
        inFinal = true;
        everInFinal = true;
      } else {
        continue;
      }
      lastFinalIndex = idx + match.text.length;
    }

    if (inFinal) {
      result += processed.slice(lastFinalIndex);
    }
    stateLocal.final = inFinal;

    // Untagged narration must stay hidden until the first final tag.
    if (!everInFinal) {
      stateLocal.inlineCode = createInlineCodeState();
      stateLocal.fence = finalCodeSpans.fenceState;
      stateLocal.finalInlineCode = undefined;
      stateLocal.finalFence = undefined;
      return "";
    }

    // Nested final tags still need stripping.
    const finalResultInlineStateStart = stateLocal.finalInlineCode ?? createInlineCodeState();
    const finalResultFenceStateStart = stateLocal.finalFence;
    const resultCodeSpans = buildCodeSpanIndex(
      result,
      finalResultInlineStateStart,
      finalResultFenceStateStart,
    );
    stateLocal.inlineCode = finalCodeSpans.inlineState;
    stateLocal.fence = finalCodeSpans.fenceState;
    stateLocal.finalInlineCode = inFinal ? resultCodeSpans.inlineState : undefined;
    stateLocal.finalFence = inFinal ? resultCodeSpans.fenceState : undefined;
    return stripFinalTagsOutsideCodeSpans(result, resultCodeSpans.isInside);
  };

  const stripFinalTagsOutsideCodeSpans = (text: string, isInside: (index: number) => boolean) => {
    let output = "";
    let lastIndex = 0;
    for (const match of findFinalTagMatches(text)) {
      const idx = match.index;
      if (isInside(idx)) {
        continue;
      }
      output += text.slice(lastIndex, idx);
      lastIndex = idx + match.text.length;
    }
    output += text.slice(lastIndex);
    return output;
  };
  const emitBlockChunk: EmbeddedAgentSubscribeContext["emitBlockChunk"] = (text, options) => {
    if (
      state.suppressBlockChunks ||
      params.silentExpected ||
      shouldSuppressDeterministicApprovalOutput(state)
    ) {
      return;
    }
    const blockReplyText = options?.final === true ? text.trimEnd() : text;
    const hasPendingAudioDirective = state.pendingAssistantReplyDirectives?.audioAsVoice === true;
    if (!blockReplyText.trim() && !options?.finalReply && !hasPendingAudioDirective) {
      return;
    }
    const markBlockReplyTextHandled = () => {
      if (blockReplyText) {
        state.lastBlockReplyText = blockReplyText;
        state.lastDeliveredBlockReplyText = blockReplyText;
      }
      state.toolExecutionSinceLastBlockReply = false;
    };
    if (shouldSuppressSourceReplyOutput({ params, state })) {
      markBlockReplyTextHandled();
      return;
    }
    let chunk = blockReplyText;
    let slicedPrefixReplay = false;
    const lastDeliveredBlockReplyText = state.lastDeliveredBlockReplyText;
    const blockReplySuffix = lastDeliveredBlockReplyText
      ? blockReplyText.slice(lastDeliveredBlockReplyText.length)
      : "";
    // A deferred prefix was never delivered and may be superseded at terminal release.
    const prefixReplayCandidate = Boolean(
      !state.deferBlockReplyDelivery &&
      state.blockReplyBreak === "text_end" &&
      state.toolExecutionSinceLastBlockReply &&
      lastDeliveredBlockReplyText &&
      lastDeliveredBlockReplyText.trimEnd().endsWith(":") &&
      blockReplyText.length > lastDeliveredBlockReplyText.length &&
      blockReplyText.startsWith(lastDeliveredBlockReplyText),
    );
    if (prefixReplayCandidate && !/^\s/.test(blockReplySuffix)) {
      chunk = blockReplySuffix;
      slicedPrefixReplay = true;
    }
    if (!chunk && !options?.finalReply && !hasPendingAudioDirective) {
      return;
    }

    // Only check committed (successful) messaging tool texts - checking pending texts
    // is risky because if the tool fails after suppression, the user gets no response
    const normalizedChunk = normalizeTextForComparison(chunk);
    const normalizedReplaySuffix = prefixReplayCandidate
      ? normalizeTextForComparison(blockReplySuffix.trimStart())
      : "";
    const isMessagingDuplicate =
      isMessagingToolDuplicateNormalized(normalizedChunk, messagingToolSentTextsNormalized) ||
      (prefixReplayCandidate &&
        isMessagingToolDuplicateNormalized(
          normalizedReplaySuffix,
          messagingToolSentTextsNormalized,
        ));
    if (isMessagingDuplicate) {
      if (prefixReplayCandidate) {
        markBlockReplyTextHandled();
      }
      return;
    }

    const assistantMessageIndex = options?.assistantMessageIndex ?? state.assistantMessageIndex;
    const blockSourceText = options?.sourceText;
    const sourceStart = options?.sourceStart;
    const sourceEnd = options?.sourceEnd;
    const blockSourceRange =
      blockSourceText !== undefined && sourceStart !== undefined && sourceEnd !== undefined
        ? ([sourceStart, sourceEnd] as const)
        : undefined;
    let sourceAlreadyEmitted = false;
    if (blockSourceRange) {
      const covered = coveredBlockSources.get(assistantMessageIndex) ?? [];
      const [start, end] = blockSourceRange;
      let cursor = start;
      let coveredText = "";
      for (const entry of covered.toSorted((a, b) => a.range[0] - b.range[0])) {
        const [coveredStart, coveredEnd] = entry.range;
        if (coveredEnd <= cursor) {
          continue;
        }
        if (coveredStart > cursor) {
          break;
        }
        const overlap = cursor - coveredStart;
        const length = Math.min(end, coveredEnd) - cursor;
        coveredText += entry.text.slice(overlap, overlap + length);
        cursor += length;
        if (cursor >= end) {
          break;
        }
      }
      sourceAlreadyEmitted = cursor >= end && coveredText === blockSourceText;
    }
    if (
      chunk &&
      (sourceAlreadyEmitted ||
        ((!blockSourceRange ||
          !coveredBlockSources.has(assistantMessageIndex) ||
          options?.reconciledSourceBreak) &&
          shouldSkipAssistantText(chunk, normalizedChunk)))
    ) {
      if (slicedPrefixReplay) {
        markBlockReplyTextHandled();
      }
      if (!options?.finalReply) {
        return;
      }
      chunk = "";
    }

    if (!params.onBlockReply) {
      pushAssistantText(chunk, normalizedChunk);
      markBlockReplyTextHandled();
      return;
    }
    // Prepared chunks already removed real directives with full source context;
    // a chunk boundary can separate a remaining literal from its code opener.
    let splitResult: ReplyDirectiveParseResult = {
      text: chunk,
      replyToTag: false,
    };
    if (options?.finalReply) {
      let pendingText = splitResult.text;
      if (trimTextPreservingCode(pendingText) === options.finalReply.text) {
        pendingText = options.finalReply.text;
        chunk = pendingText;
      }
      splitResult = { ...splitResult, ...options.finalReply, text: pendingText };
    }
    const {
      text: cleanedText,
      mediaUrls,
      mediaFailures,
      audioAsVoice,
      replyToId,
      replyToTag,
      replyToCurrent,
    } = splitResult;
    const hasPendingFinalMedia = Boolean(
      options?.finalReply?.text && state.pendingToolMediaUrls.length,
    );
    if (
      !cleanedText &&
      !mediaFailures?.length &&
      (!mediaUrls || mediaUrls.length === 0) &&
      !audioAsVoice &&
      !hasPendingAudioDirective &&
      !hasPendingFinalMedia
    ) {
      if (slicedPrefixReplay) {
        markBlockReplyTextHandled();
      }
      return;
    }
    pushAssistantText(chunk, normalizedChunk);
    const payload = {
      text: cleanedText || appendReplyMediaFailures(cleanedText, mediaFailures ?? []),
      mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
      audioAsVoice,
      replyToId,
      replyToTag,
      replyToCurrent,
    };
    addReplyPayloadMediaFailures(payload, mediaFailures);
    const emittedBlockSourceRange =
      chunk === blockReplyText &&
      cleanedText === chunk &&
      !sourceAlreadyEmitted &&
      !options?.reconciledSourceBreak
        ? blockSourceRange
        : undefined;
    emitBlockReply(payload, {
      assistantMessageIndex,
      blockSourceText:
        chunk === blockReplyText &&
        cleanedText === chunk &&
        (options?.sourceStart === undefined || emittedBlockSourceRange !== undefined)
          ? blockSourceText
          : undefined,
      blockSourceRange: emittedBlockSourceRange,
      consumePendingToolMedia:
        options?.finalReply !== undefined ||
        hasPendingAudioDirective ||
        Boolean(mediaUrls?.length || audioAsVoice),
    });
    if (emittedBlockSourceRange) {
      const covered = coveredBlockSources.get(assistantMessageIndex) ?? [];
      covered.push({ range: emittedBlockSourceRange, text: blockSourceText ?? "" });
      coveredBlockSources.set(assistantMessageIndex, covered);
    }
    markBlockReplyTextHandled();
  };

  const consumePartialReplyDirectives = (text: string, options?: { final?: boolean }) =>
    partialReplyDirectiveAccumulator.consume(text, options);
  const resetPartialReplyDirectives = () => {
    partialReplyDirectiveAccumulator.reset();
    state.lastAssistantAudioDirectiveCount = 0;
    state.pendingAssistantReplyDirectives = undefined;
  };

  const flushBlockReplyBuffer: EmbeddedAgentSubscribeContext["flushBlockReplyBuffer"] = (
    options,
  ) => {
    flushAssistantStream();
    if (!params.onBlockReply) {
      return undefined;
    }
    let pendingChunk: ({ text: string } & Partial<BlockChunkMetadata>) | undefined;
    if (blockChunker.hasBuffered()) {
      blockChunker.drain({
        force: true,
        emit: (text, metadata) => {
          if (pendingChunk !== undefined) {
            emitBlockChunk(pendingChunk.text, {
              sourceText: pendingChunk.sourceText,
              reconciledSourceBreak: pendingChunk.reconciledSourceBreak,
              sourceStart: pendingChunk.sourceStart,
              sourceEnd: pendingChunk.sourceEnd,
              assistantMessageIndex: options?.assistantMessageIndex,
            });
          }
          pendingChunk = { text, ...metadata };
        },
      });
    }
    if (
      pendingChunk !== undefined ||
      options?.final ||
      state.pendingAssistantReplyDirectives?.audioAsVoice === true
    ) {
      // Only the final chunk can select attachments or consume fallback tool
      // media. Intermediate chunks remain text-only until that selection exists.
      emitBlockChunk(pendingChunk?.text ?? "", {
        ...options,
        final: options?.final === true,
        sourceText: pendingChunk?.sourceText,
        reconciledSourceBreak: pendingChunk?.reconciledSourceBreak,
        sourceStart: pendingChunk?.sourceStart,
        sourceEnd: pendingChunk?.sourceEnd,
      });
    }
    if (pendingBlockReplyTasks.size === 0) {
      return undefined;
    }
    return (async () => {
      while (pendingBlockReplyTasks.size > 0) {
        await Promise.allSettled(pendingBlockReplyTasks);
      }
    })();
  };

  const emitReasoningStream: EmbeddedAgentSubscribeContext["emitReasoningStream"] = (
    input,
    fallback,
  ) => {
    if (params.silentExpected) {
      return;
    }
    const previousProjectedText = reasoningProjection.text;
    const projected = reasoningProjection.update(input, fallback);
    const trimmed = projected.text;
    if (!trimmed || trimmed === state.lastStreamedReasoning) {
      return;
    }
    // Transcript persistence completes this same occurrence receipt after message_end.
    const source = readAgentAssistantSource(state.lastAssistant);
    const itemId = source ? (source.itemId ??= randomUUID()) : undefined;
    flushAssistantStream();
    // Partial callbacks can advance reasoning while the assistant scope flushes.
    const prior = state.lastStreamedReasoning ?? "";
    const delta =
      previousProjectedText === prior && projected.delta !== null
        ? projected.delta
        : trimmed.startsWith(prior)
          ? trimmed.slice(prior.length)
          : trimmed;
    state.lastStreamedReasoning = trimmed;

    // Archive thinking regardless of /reasoning; that setting gates the rendering hook.
    emitAgentEventWithAssistantSourceIfCurrent(
      {
        runId: params.runId,
        stream: "thinking",
        data: { text: trimmed, delta, ...(itemId ? { itemId } : {}) },
      },
      source,
    );

    // A completed source reply suppresses later reasoning from channel rendering,
    // including reasoning attached to tool calls. The archive above still receives it.
    if (
      state.streamReasoning &&
      !shouldSuppressSourceReplyOutput({ params, state }) &&
      params.onReasoningStream
    ) {
      runBestEffortCallback({
        label: "reasoning stream",
        log,
        callback: () =>
          params.onReasoningStream?.({
            text: trimmed,
            ...(state.reasoningMode === "stream" ? {} : { requiresReasoningProgressOptIn: true }),
          }),
      });
    }
  };

  const resetAssistantMessageState = (nextAssistantTextBaseline: number) => {
    flushAssistantStream();
    state.deltaBuffer = "";
    state.streamBlockText = "";
    state.streamBlockFinal = false;
    state.blockReplyScopeStart = undefined;
    state.blockReplyTextUnsettled = false;
    state.thinkingTagStream = createThinkingTagStreamState();
    state.deltaBufferIsCommentary = false;
    state.hasFlushedPartialText = false;
    blockChunker.reset();
    resetPartialReplyDirectives();
    state.partialBlockState = createAssistantStreamBlockState();
    state.assistantStream = undefined;
    state.nextCommentaryAt = undefined;
    state.currentSourceMessagingToolHeldPartial = undefined;
    state.lastBlockReplyText = undefined;
    state.lastStreamedReasoning = undefined;
    reasoningProjection = createAssistantThinkingStream();
    state.reasoningStreamOpen = false;
    state.suppressBlockChunks = false;
    state.assistantMessageIndex += 1;
    state.lastAssistantStreamContentIndex = undefined;
    state.lastAssistantStreamItemId = undefined;
    state.assistantTextBaseline = nextAssistantTextBaseline;
  };

  return {
    consumePartialReplyDirectives,
    getPartialReplySourceText: () => partialReplyDirectiveAccumulator.sourceText,
    resetPartialReplyDirectives,
    emitBlockChunk,
    emitReasoningStream,
    flushBlockReplyBuffer,
    resetAssistantMessageState,
    stripBlockTags,
  };
}

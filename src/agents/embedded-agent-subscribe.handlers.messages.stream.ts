import { OPENAI_RESPONSES_APIS } from "@openclaw/ai/internal/openai-responses-payload-policy";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import {
  asOptionalObjectRecord,
  asOptionalRecord as asRecord,
} from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import {
  createStreamingDirectiveAccumulator,
  splitTrailingDirective,
} from "../auto-reply/reply/streaming-directives.js";
import { readAutomationDisplayState } from "../infra/agent-run-registry.automation.js";
import type { AssistantMessage } from "../llm/types.js";
import {
  parseAssistantTextSignature,
  readAssistantTextBlocksForPhase,
} from "../shared/chat-message-content.js";
import { toolCallXmlTextFilter } from "../shared/text/assistant-visible-text.js";
import {
  canReuseMarkdownOwnershipForAppend,
  findCodeOwnership,
} from "../shared/text/code-regions.js";
import { downgradedToolCallTextFilter } from "../shared/text/downgraded-tool-call-text.js";
import { createTextProjection, trimTextPreservingCode } from "../shared/text/text-projection.js";
import {
  findDirectiveCodePrefix,
  type StreamDirectiveCodePrefix,
} from "../utils/directive-tags.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import { hasReplyDirectiveMetadata } from "./embedded-agent-subscribe.handlers.messages.replies.js";
import type {
  EmbeddedAgentSubscribeContext,
  EmbeddedAgentSubscribeState,
  StreamingReplyResolver,
} from "./embedded-agent-subscribe.handlers.types.js";
import {
  extractAssistantCommentaryText,
  stripDowngradedToolCallText,
} from "./embedded-agent-utils.js";
import type { AgentMessage } from "./runtime/index.js";

export function isSubscribeTranscriptOnlyOpenClawAssistantMessage(
  message: AgentMessage | undefined,
): boolean {
  if (!message || message.role !== "assistant") {
    return false;
  }
  const provider = normalizeOptionalString(message.provider) ?? "";
  const model = normalizeOptionalString(message.model) ?? "";
  return provider === "openclaw" && (model === "delivery-mirror" || model === "gateway-injected");
}

function readAssistantMessageApi(message: AgentMessage | undefined) {
  return message?.role === "assistant" ? normalizeOptionalString(message.api) : undefined;
}

export function isResponsesApiAssistantMessage(message: AgentMessage | undefined): boolean {
  return OPENAI_RESPONSES_APIS.has(readAssistantMessageApi(message) ?? "");
}

export function isOpenAiCompletionsAssistantMessage(message: AgentMessage | undefined): boolean {
  const api = readAssistantMessageApi(message);
  return api === "openai-completions" || api === "openclaw-openai-completions-transport";
}

export function extractStandaloneMessageToolText(
  text: string,
  params: { allowCurrentSourceReply?: boolean; allowRoutedReply?: boolean } = {},
): string | undefined {
  if (!params.allowCurrentSourceReply && !params.allowRoutedReply) {
    return undefined;
  }
  const record = safeParseJsonRecord(text.trim());
  const args = asRecord(record?.arguments);
  const hasRoute = Boolean(
    normalizeOptionalString(args?.target) ||
    normalizeOptionalString(args?.to) ||
    normalizeOptionalString(args?.channel) ||
    normalizeOptionalString(args?.accountId) ||
    Array.isArray(args?.targets),
  );
  if (
    normalizeOptionalString(record?.name) !== "message" ||
    normalizeOptionalString(args?.action) !== "send" ||
    (hasRoute ? !params.allowRoutedReply : !params.allowCurrentSourceReply)
  ) {
    return undefined;
  }
  return normalizeOptionalString(args?.message);
}

function isAssistantTextBlock(value: unknown): value is { type: "text"; textSignature?: unknown } {
  return asOptionalObjectRecord(value)?.type === "text";
}

export function resolveAssistantStreamItemId(params: {
  contentIndex?: unknown;
  message: AgentMessage | undefined;
}): string | undefined {
  const content = (params.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const contentIndex = resolveAssistantStreamContentIndex(params.contentIndex);
  const indexedBlock = contentIndex !== undefined ? content[contentIndex] : undefined;
  const hasIndexedTextBlock = isAssistantTextBlock(indexedBlock);
  const candidateStart =
    hasIndexedTextBlock && contentIndex !== undefined ? contentIndex : content.length - 1;
  const candidateEnd = hasIndexedTextBlock ? candidateStart : 0;
  for (let index = candidateStart; index >= candidateEnd; index -= 1) {
    const block = content[index];
    if (!isAssistantTextBlock(block)) {
      continue;
    }
    const signature = parseAssistantTextSignature(block);
    if (signature?.id) {
      return signature.id;
    }
  }
  return undefined;
}

export function resolveAssistantStreamContentIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function resolveAssistantStreamBlockIndex(
  message: AssistantMessage,
  contentIndex: number | undefined,
  itemId: string | undefined,
): number | undefined {
  if (!Array.isArray(message.content)) {
    return undefined;
  }
  const indexedBlock = contentIndex === undefined ? undefined : message.content[contentIndex];
  if (isAssistantTextBlock(indexedBlock)) {
    return contentIndex;
  }
  const index = itemId
    ? message.content.findLastIndex(
        (candidate) =>
          isAssistantTextBlock(candidate) && parseAssistantTextSignature(candidate)?.id === itemId,
      )
    : -1;
  return index >= 0 ? index : undefined;
}

export function scopeAssistantMessageToStreamBlock(
  message: AssistantMessage,
  contentIndex: number | undefined,
  itemId: string | undefined,
): AssistantMessage {
  const index = resolveAssistantStreamBlockIndex(message, contentIndex, itemId);
  if (index === undefined || !Array.isArray(message.content)) {
    return message;
  }
  const block = message.content[index];
  if (!block) {
    return message;
  }
  // Provider partials are cumulative across content blocks. Once a content
  // index becomes a logical reply boundary, downstream snapshots must be
  // cumulative only within that block or earlier text is replayed.
  return { ...message, content: [block] };
}

export function emitAssistantCommentaryStreamData(
  ctx: EmbeddedAgentSubscribeContext,
  message: AssistantMessage,
  finalMessage = false,
) {
  const isResponsesCommentary = isResponsesApiAssistantMessage(message);
  const { lastAssistantStreamContentIndex: index, lastAssistantStreamItemId: itemId } = ctx.state;
  // Non-text updates carry prior Responses items too; publish only the active item.
  let commentaryMessages = [scopeAssistantMessageToStreamBlock(message, index, itemId)];
  if (!isResponsesCommentary) {
    const blocks = readAssistantTextBlocksForPhase(message, "commentary");
    // Generic partials retain earlier items; keep each snapshot under its original identity.
    commentaryMessages = [message];
    if (Array.isArray(message.content)) {
      commentaryMessages = [];
      for (const id of new Set(blocks.map((block) => parseAssistantTextSignature(block)?.id))) {
        const content = message.content.filter(
          (block) =>
            block.type === "text" &&
            blocks.some((selected) => selected === block) &&
            parseAssistantTextSignature(block)?.id === id,
        );
        commentaryMessages.push({ ...message, content });
      }
    }
  }
  for (const commentaryMessage of commentaryMessages) {
    const accumulator = createStreamingDirectiveAccumulator();
    const text = extractAssistantCommentaryText(commentaryMessage, (part, final) => {
      const preparedStart = accumulator.sourceText.length;
      accumulator.consume(part, { final: finalMessage && final });
      return accumulator.sourceText.slice(preparedStart);
    });
    if (!text || (!finalMessage && isResponsesCommentary && ctx.state.deltaBuffer === text)) {
      continue;
    }
    const commentaryItemId = isResponsesCommentary
      ? itemId
      : resolveAssistantStreamItemId({ message: commentaryMessage });
    ctx.emitAssistantStreamData(
      { text, delta: "", replace: true, phase: "commentary", itemId: commentaryItemId },
      { finalMessage },
    );
  }
}

export function emitReasoningEnd(ctx: EmbeddedAgentSubscribeContext) {
  if (!ctx.state.reasoningStreamOpen) {
    return;
  }
  ctx.flushAssistantStream();
  ctx.state.reasoningStreamOpen = false;
  runBestEffortCallback({
    label: "reasoning end",
    log: ctx.log,
    callback: () => ctx.params.onReasoningEnd?.(),
  });
}

export function emitPersistentReasoning(ctx: EmbeddedAgentSubscribeContext, text: string) {
  if (
    !ctx.state.includeReasoning ||
    !text ||
    !ctx.params.onBlockReply ||
    ctx.params.silentExpected ||
    shouldSuppressDeterministicApprovalOutput(ctx.state) ||
    shouldSuppressSourceReplyOutput(ctx) ||
    text === ctx.state.lastReasoningSent
  ) {
    return;
  }
  const previous = ctx.state.lastReasoningSent;
  const pending =
    previous && text.startsWith(previous) ? text.slice(previous.length).trimStart() : text;
  ctx.state.lastReasoningSent = text;
  // Keep reasoning separate from answer/tool payloads, in provider order.
  if (pending) {
    ctx.emitBlockReply({ text: pending, isReasoning: true });
  }
}

export function emitAssistantMessageStart(ctx: EmbeddedAgentSubscribeContext) {
  ctx.flushAssistantStream();
  runBestEffortCallback({
    label: "assistant message start",
    log: ctx.log,
    callback: () => ctx.params.onAssistantMessageStart?.(),
  });
}

export function openReasoningStream(ctx: EmbeddedAgentSubscribeContext) {
  if (!ctx.state.reasoningStreamOpen) {
    ctx.flushAssistantStream();
  }
  ctx.state.reasoningStreamOpen = true;
}

export function shouldSuppressDeterministicApprovalOutput(
  state: Pick<
    EmbeddedAgentSubscribeState,
    "deterministicApprovalPromptPending" | "deterministicApprovalPromptSent"
  >,
): boolean {
  return state.deterministicApprovalPromptPending || state.deterministicApprovalPromptSent;
}

export function shouldSuppressSourceReplyOutput(
  ctx: Pick<EmbeddedAgentSubscribeContext, "params" | "state">,
  assistant = ctx.state.lastAssistant,
): boolean {
  return (
    // Scheduled text remains provisional until cron publishes the settled result.
    (readAutomationDisplayState(ctx.params.runId) !== "ordinary" &&
      assistant?.stopReason !== "error" &&
      assistant?.stopReason !== "aborted") ||
    ctx.state.sourceReplyDeliveryState === "delivered" ||
    (ctx.params.sourceReplyDeliveryMode === "message_tool_only" &&
      (ctx.state.messageToolOnlySourceReplyDelivered ||
        ctx.params.hasDeliveredMessageToolOnlySourceReply?.() === true ||
        (ctx.state.messagingToolSourceReplyPayloads?.length ?? 0) > 0))
  );
}

export function resolveAssistantTextChunk(params: {
  evtType: "text_delta" | "text_start" | "text_end";
  delta: string;
  content: string;
  accumulatedText: string;
}): string {
  const { evtType, delta, content, accumulatedText } = params;
  if (evtType === "text_delta" || delta) {
    return delta;
  }
  if (!content) {
    return "";
  }
  // KNOWN: Some providers resend full content on `text_end`.
  // We only append a suffix (or nothing) to keep output monotonic.
  if (content.startsWith(accumulatedText)) {
    return content.slice(accumulatedText.length);
  }
  return "";
}

export function createStreamingReplyResolver(): StreamingReplyResolver {
  const rawProjection = createTextProjection([
    downgradedToolCallTextFilter(),
    toolCallXmlTextFilter({ stripFunctionCallsXmlPayloads: true }, true),
  ]);
  let directiveCodePrefix: StreamDirectiveCodePrefix | undefined;
  let hasDirectiveMarker = false;
  let previousChar = "";
  // A stripped directive (media line, audio/reply tag) leaves the raw visible prefix longer than
  // the cleaned text, so the append paths below cannot prove an append and every delta re-parses
  // the whole reply. Track the exact source the canonical parse consumed so a byte-exact,
  // directive-free append can reuse its result instead.
  let settledDirectiveSource: string | undefined;
  let settledDirectiveText = "";
  let settledDirectiveTail = false;
  // A removed inline directive can retroactively own surrounding whitespace, so a prefix that
  // removed a marker stays on the canonical parse.
  let settledDirectiveMarked = false;
  // An invalid media reference rewrites its notice in place as the line grows, so those replies
  // keep the canonical parse.
  let settledDirectiveNotice = false;
  // Canonical identity can extend only while Markdown ownership remains unchanged.
  let literalMarkerSource: string | undefined;
  let literalMarkerOwnership: Parameters<typeof canReuseMarkdownOwnershipForAppend>[2];
  return (params) => {
    let preparedRawText = params.next;
    let ownershipDelta = params.appendDelta;
    if (params.rawDirectiveSource !== undefined) {
      // Directive parsing needs pre-trim coordinates, independently of the visible projection.
      const projected =
        params.rawDirectiveDelta === undefined
          ? rawProjection.replace(params.rawDirectiveSource)
          : rawProjection.append(params.rawDirectiveDelta, params.rawDirectiveSource);
      preparedRawText = projected.text;
      ownershipDelta = projected.delta;
      // Untrimmed sources answer to their own trim owner, so the settled clean prefix does not
      // apply to them.
      settledDirectiveSource = undefined;
    }
    if (ownershipDelta === null) {
      hasDirectiveMarker = false;
      previousChar = "";
    }
    const appended = ownershipDelta ?? preparedRawText;
    if ((previousChar + appended).includes("[[")) {
      hasDirectiveMarker = true;
      // A fresh marker is unproven until the canonical parse covers it.
      literalMarkerSource = undefined;
      directiveCodePrefix = undefined;
    }
    if (appended) {
      previousChar = appended.slice(-1);
    }
    if (params.appendDelta === null || ownershipDelta === null) {
      directiveCodePrefix = undefined;
      settledDirectiveSource = undefined;
      literalMarkerSource = undefined;
    }
    if (literalMarkerSource !== undefined) {
      literalMarkerSource =
        ownershipDelta !== null &&
        canReuseMarkdownOwnershipForAppend(
          literalMarkerSource,
          ownershipDelta,
          (literalMarkerOwnership ??= findCodeOwnership(literalMarkerSource)),
        )
          ? preparedRawText
          : undefined;
    }
    if (!params.parsedStreamDirectives && params.evtType === "text_delta") {
      if (params.rawDirectiveSource?.length !== directiveCodePrefix?.checkedRawLength) {
        directiveCodePrefix = undefined;
      }
      const text = params.previousCleaned;
      return {
        text,
        delta: "",
        replace: false,
        hasText: Boolean(text.trim()),
        replyDirectives: null,
        audioDirectiveCount: params.previousAudioDirectiveCount,
      };
    }

    let text: string | undefined;
    let delta: string | undefined;
    let isAppend = false;
    let replyDirectives = params.parsedStreamDirectives;
    let audioDirectiveCount = params.previousAudioDirectiveCount;
    if (
      params.evtType !== "text_end" &&
      params.parsedStreamDirectives &&
      !hasReplyDirectiveMetadata(params.parsedStreamDirectives) &&
      !/(?:^|\n)[^\S\n]*MEDIA:\s*\S[^\n]*(?:\n|$)/i.test(params.visibleDelta) &&
      params.parsedStreamDirectives.text === params.visibleDelta &&
      params.appendDelta !== null &&
      params.previousText === params.previousCleaned &&
      (directiveCodePrefix || !hasDirectiveMarker || literalMarkerSource !== undefined)
    ) {
      // Visibility and trim owners already prepared this exact append.
      text = params.next;
      delta = params.appendDelta;
      isAppend = true;
      if (directiveCodePrefix && params.rawDirectiveSource !== undefined) {
        directiveCodePrefix = {
          ...directiveCodePrefix,
          checkedRawLength: params.rawDirectiveSource.length,
        };
      }
    }
    if (
      text === undefined &&
      params.evtType !== "text_end" &&
      params.parsedStreamDirectives &&
      params.parsedStreamDirectives.text === params.visibleDelta &&
      params.appendDelta !== null &&
      params.previousCleaned &&
      params.previousText.length > params.previousCleaned.length &&
      !/(?:^|\n)[^\S\n]*MEDIA:\s*\S[^\n]*(?:\n|$)/i.test(params.visibleDelta)
    ) {
      const marker = params.previousText.lastIndexOf("[[");
      const tailStart = params.previousText.indexOf("]]", marker + 2) + 2;
      const tail = params.previousText.slice(tailStart);
      const source = params.rawDirectiveSource ?? params.next;
      // Settled directives before any code opener cannot enter code on append.
      // New markers and reference definitions still require the complete Markdown context.
      if (
        marker >= 0 &&
        tailStart > marker + 2 &&
        tail.trim() &&
        params.previousCleaned.endsWith(tail.trimStart()) &&
        !/[`~\t]| {4}/u.test(params.previousText.slice(0, marker)) &&
        !source.includes("[[", params.previousText.length - 1) &&
        !source.includes("]:")
      ) {
        text = params.previousCleaned + params.appendDelta;
        delta = params.appendDelta;
        isAppend = true;
      }
    }

    if (
      text === undefined &&
      params.rawDirectiveSource === undefined &&
      params.evtType !== "text_end" &&
      params.appendDelta !== null &&
      params.parsedStreamDirectives &&
      !hasReplyDirectiveMetadata(params.parsedStreamDirectives) &&
      settledDirectiveSource !== undefined &&
      !settledDirectiveTail &&
      (!settledDirectiveMarked || literalMarkerSource !== undefined) &&
      !settledDirectiveNotice &&
      params.next.length === settledDirectiveSource.length + params.appendDelta.length &&
      params.next.endsWith(params.appendDelta) &&
      !params.appendDelta.includes("[[") &&
      !params.appendDelta.endsWith("[") &&
      !/(?:^|[\r\n])[^\S\r\n]*MEDIA:/iu.test(
        settledDirectiveSource.slice(-1) + params.appendDelta,
      ) &&
      !/(?:^|[\r\n])[\t ]*(?:M|ME|MED|MEDI|MEDIA)$/iu.test(
        settledDirectiveSource.slice(-1) + params.appendDelta,
      )
    ) {
      // The visible text grew by exactly the reported delta and the new bytes cannot start or
      // complete a directive, so every directive the cleaned prefix already removed stays removed.
      text = settledDirectiveText + params.appendDelta;
      delta = params.appendDelta;
      isAppend = true;
    }

    if (text === undefined) {
      directiveCodePrefix = undefined;
      audioDirectiveCount = 0;
      const source =
        params.rawDirectiveSource === undefined || params.evtType !== "text_end"
          ? preparedRawText
          : toolCallXmlTextFilter(
              { stripFunctionCallsXmlPayloads: true },
              params.evtType !== "text_end",
            ).transform(stripDowngradedToolCallText(params.rawDirectiveSource));
      const split = params.evtType === "text_end" ? undefined : splitTrailingDirective(source);
      const parsed = parseReplyDirectives(split ? split.text : source, {
        onAudioDirective: () => {
          audioDirectiveCount += 1;
        },
      });
      text =
        params.rawDirectiveSource === undefined ? parsed.text : trimTextPreservingCode(parsed.text);
      // Record the settled prefix this parse produced: the exact source it consumed, its cleaned
      // text, and whether an incomplete directive tail was held back from both.
      settledDirectiveSource =
        params.rawDirectiveSource === undefined && params.evtType !== "text_end"
          ? preparedRawText
          : undefined;
      settledDirectiveText = text;
      settledDirectiveTail = Boolean(split?.tail);
      settledDirectiveMarked =
        settledDirectiveSource !== undefined && preparedRawText.includes("[[");
      settledDirectiveNotice = Boolean(parsed.mediaFailures?.length);
      // Identity proves every `[[...]]` in this prefix is literal prose, so later appends that the
      // directive owner reports as plain text can extend it. A held tail, a stripped directive, a
      // media notice, or reply metadata all mean the marker changed the text and the proof fails.
      literalMarkerOwnership = undefined;
      literalMarkerSource =
        source.includes("[[") &&
        parsed.text === source &&
        !split?.tail &&
        !parsed.mediaFailures?.length &&
        !parsed.mediaUrls?.length &&
        !hasReplyDirectiveMetadata(parsed)
          ? source
          : undefined;
      if (
        params.evtType !== "text_end" &&
        params.appendDelta !== null &&
        source === params.rawDirectiveSource &&
        text === params.next &&
        !hasReplyDirectiveMetadata(parsed) &&
        !parsed.mediaUrls?.length
      ) {
        const prefix = findDirectiveCodePrefix(source, params.visibleDelta);
        if (prefix && params.next.startsWith(source.slice(0, prefix.end))) {
          // Both raw and projected appends retain this canonical code prefix.
          directiveCodePrefix = prefix;
        }
      }
      if (replyDirectives) {
        // Metadata comes from complete code context. Only newly accepted audio
        // occurrences create a streaming edge; prior voice tags are not replayed.
        replyDirectives = {
          ...replyDirectives,
          replyToId: parsed.replyToId,
          replyToCurrent: parsed.replyToCurrent,
          replyToTag: parsed.replyToTag,
          audioAsVoice: audioDirectiveCount > params.previousAudioDirectiveCount,
        };
      }
    } else if (params.rawDirectiveSource === undefined && params.evtType !== "text_end") {
      // The appended text above is byte-exact, so it can seed the same settled prefix.
      settledDirectiveSource = params.next;
      settledDirectiveText = text;
      settledDirectiveTail = false;
    }
    const replace = Boolean(
      !isAppend && params.previousCleaned && !text.startsWith(params.previousCleaned),
    );
    return {
      text,
      delta: replace ? "" : (delta ?? text.slice(params.previousCleaned.length)),
      replace,
      hasText: Boolean(isAppend ? text : text.trim()),
      replyDirectives,
      audioDirectiveCount,
    };
  };
}

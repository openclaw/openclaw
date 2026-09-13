import { createInlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import { splitTrailingDirective } from "../auto-reply/reply/streaming-directives.js";
import type { AssistantMessage } from "../llm/types.js";
import { findCodeRegions } from "../shared/text/code-regions.js";
import {
  resolveAssistantStreamBlockIndex,
  resolveAssistantStreamItemId,
} from "./embedded-agent-subscribe.handlers.messages.stream.js";
import type {
  EmbeddedAgentSubscribeContext,
  EmbeddedAgentSubscribeState,
} from "./embedded-agent-subscribe.handlers.types.js";
import {
  extractAssistantVisibleText,
  sanitizeAssistantVisibleStreamText,
  stripDowngradedToolCallText,
} from "./embedded-agent-utils.js";

export function extractAssistantStreamSnapshot(
  ctx: EmbeddedAgentSubscribeContext,
  message: AssistantMessage,
  options?: { final?: boolean; throughIndex?: number; observedText?: string },
) {
  let observedMessage = message;
  if (options?.throughIndex !== undefined && Array.isArray(message.content)) {
    const content = message.content.slice(0, options.throughIndex + 1);
    if (options.observedText !== undefined) {
      const current = content[options.throughIndex];
      if (current?.type === "text") {
        content[options.throughIndex] = {
          type: "text",
          text: options.observedText,
          textSignature: current.textSignature,
        };
      } else if (content.length === 0) {
        content.push({ type: "text", text: options.observedText });
      }
    }
    observedMessage = { ...message, content };
  } else if (options?.observedText !== undefined) {
    observedMessage = { ...message, content: [{ type: "text", text: options.observedText }] };
  }
  const state: EmbeddedAgentSubscribeState["partialBlockState"] = {
    thinking: false,
    final: false,
    inlineCode: createInlineCodeState(),
  };
  let rawText = "";
  let blockSource = "";
  let finalAnswer = true;
  const parts: { separator: string; index?: number }[] = [];
  const text = extractAssistantVisibleText(observedMessage, (part, final, phase, index) => {
    // Native blocks can divide a tag or fence; only complete visible parts get a separator.
    const separator =
      rawText && !state.pendingTagFragment && !state.pendingFenceFragment ? "\n" : "";
    parts.push({ separator, index });
    rawText += `${separator}${part}`;
    // Final prose preserves inline tag examples; generic streams still hide reasoning.
    const preparedFinal = phase === "final_answer" && !ctx.params.enforceFinalTag;
    finalAnswer &&= preparedFinal;
    const visible = preparedFinal
      ? `${separator}${part}`
      : ctx.stripBlockTags(`${separator}${part}`, state, {
          final: final && options?.final !== false,
        });
    blockSource += visible;
    return preparedFinal ? part : visible;
  });
  const visibleBlockSource = finalAnswer
    ? sanitizeAssistantVisibleStreamText(blockSource, "final_answer", {
        preserveTrailingWhitespace: true,
      })
    : stripDowngradedToolCallText(blockSource, { preserveTrailingWhitespace: true });
  const blockReply = parseReplyDirectives(
    options?.final === false
      ? splitTrailingDirective(visibleBlockSource, { preserveTrailingWhitespace: true }).text
      : visibleBlockSource,
    { preserveTrailingWhitespace: true },
  );
  return { text, rawText, state, parts, blockText: blockReply.text, message: observedMessage };
}

/** Reconcile one prepared source frame without translating raw or rendered offsets. */
export function reconcileBlockReplySnapshot(
  ctx: EmbeddedAgentSubscribeContext,
  previous: ReturnType<typeof extractAssistantStreamSnapshot>,
  next: ReturnType<typeof extractAssistantStreamSnapshot>,
) {
  const prefixAt = (snapshot: typeof next, index: number) => {
    if (index === 0) {
      return "";
    }
    if (index > (snapshot.parts.at(-1)?.index ?? 0)) {
      return snapshot.blockText;
    }
    return extractAssistantStreamSnapshot(ctx, snapshot.message, {
      throughIndex: index,
      observedText: "",
      final: false,
    }).blockText;
  };
  const scope = ctx.state.blockReplyScopeStart;
  const scopePosition = (snapshot: typeof next) => {
    if (!scope) {
      return { index: 0, valid: true };
    }
    const indexed = resolveAssistantStreamBlockIndex(
      snapshot.message,
      scope.contentIndex,
      undefined,
    );
    // Signatures can repeat across native parts; retain the matching indexed occurrence.
    const indexedMatch =
      indexed !== undefined &&
      (!scope.itemId ||
        resolveAssistantStreamItemId({ contentIndex: indexed, message: snapshot.message }) ===
          scope.itemId);
    // Compact frames relocate items, while snapshot extensions can rotate their signature.
    const anchor = indexedMatch
      ? indexed
      : (resolveAssistantStreamBlockIndex(snapshot.message, undefined, scope.itemId) ?? indexed);
    return {
      index: (anchor ?? scope.contentIndex) + (scope.after ? 1 : 0),
      valid: anchor !== undefined,
    };
  };
  const oldScope = scopePosition(previous);
  const nextScope = scopePosition(next);
  const origin = oldScope.index;
  const oldPrefix = prefixAt(previous, origin);
  const nextPrefix = prefixAt(next, nextScope.index);
  const oldText = previous.blockText.slice(oldPrefix.length);
  const nextText = next.blockText.slice(nextPrefix.length);
  const consumed = ctx.blockChunker.consumedLength;
  let oldCode: ReturnType<typeof findCodeRegions> | undefined;
  let nextCode: ReturnType<typeof findCodeRegions> | undefined;
  const crossesCode = (snapshot: typeof next, offset: number, includeCodeEnd = false) => {
    if (
      offset <= 0 ||
      offset > snapshot.blockText.length ||
      (offset === snapshot.blockText.length && !includeCodeEnd)
    ) {
      return false;
    }
    const regions =
      snapshot === previous
        ? (oldCode ??= findCodeRegions(previous.blockText))
        : (nextCode ??= findCodeRegions(next.blockText));
    return regions.some(
      (region) =>
        region.start < offset && (offset < region.end || (includeCodeEnd && offset === region.end)),
    );
  };
  const scopeRetained =
    oldScope.valid &&
    nextScope.valid &&
    !crossesCode(previous, oldPrefix.length) &&
    !crossesCode(next, nextPrefix.length);
  if (scopeRetained && origin > 0 && consumed === 0 && !ctx.blockChunker.hasBuffered()) {
    if (next.blockText.startsWith(nextPrefix)) {
      ctx.blockChunker.append(nextText);
      return;
    }
  }
  const retained = Math.min(consumed, nextText.length);
  const retainedPrefix =
    scopeRetained &&
    oldPrefix === nextPrefix &&
    previous.blockText.startsWith(oldPrefix) &&
    next.blockText.startsWith(nextPrefix) &&
    oldText.slice(0, retained) === nextText.slice(0, retained);
  if (
    retainedPrefix &&
    (nextText.length >= consumed || !oldText.slice(retained, consumed).trim())
  ) {
    if (consumed === oldText.length && !ctx.blockChunker.hasBuffered()) {
      for (const part of next.parts) {
        const index = part.index ?? 0;
        if (!index || !part.separator) {
          continue;
        }
        const boundary = prefixAt(next, index);
        const padding = boundary.slice(previous.blockText.length);
        if (
          boundary.startsWith(previous.blockText) &&
          padding &&
          !padding.trim() &&
          !crossesCode(next, boundary.length)
        ) {
          ctx.blockChunker.append(padding);
          ctx.blockChunker.drain({ force: true, emit: () => {} });
          break;
        }
      }
    }
    ctx.blockChunker.replace(nextText);
    return;
  }

  let restartIndex = next.parts[0]?.index ?? 0;
  let restartPrefix = "";
  for (const part of next.parts) {
    const index = part.index ?? 0;
    if (!index || !part.separator) {
      continue;
    }
    const oldBoundary = prefixAt(previous, index);
    const nextBoundary = prefixAt(next, index);
    if (
      oldBoundary === nextBoundary &&
      previous.blockText.startsWith(oldBoundary) &&
      next.blockText.startsWith(nextBoundary) &&
      oldBoundary.length <= oldPrefix.length + consumed &&
      !crossesCode(previous, oldBoundary.length) &&
      !crossesCode(next, nextBoundary.length)
    ) {
      restartIndex = index;
      restartPrefix = nextBoundary;
    }
  }
  if (retainedPrefix && nextText.length < consumed && restartPrefix !== next.blockText) {
    ctx.blockChunker.replace(nextText);
    return;
  }
  const sourceBreaks: number[] = [];
  if (
    scopeRetained &&
    oldScope.index === nextScope.index &&
    oldPrefix === nextPrefix &&
    consumed > 0
  ) {
    const limit = Math.min(oldText.length, nextText.length);
    let prefixLength = 0;
    while (
      prefixLength < limit &&
      oldText.charCodeAt(prefixLength) === nextText.charCodeAt(prefixLength)
    ) {
      prefixLength += 1;
    }
    let suffixLength = 0;
    while (
      suffixLength < limit - prefixLength &&
      oldText.charCodeAt(oldText.length - suffixLength - 1) ===
        nextText.charCodeAt(nextText.length - suffixLength - 1)
    ) {
      suffixLength += 1;
    }
    const suffixStart = oldText.length - suffixLength;
    const shift = next.blockText.length - previous.blockText.length;
    // Preserve chunk boundaries, not delivery claims: repeated source still
    // passes through the existing payload/custody decision at the recipient.
    // Include code ends because a later append can continue an unfinished fence.
    for (const end of ctx.blockChunker.preparedSourceBreaks) {
      const unchangedPrefix = end <= prefixLength;
      const oldBoundary = oldPrefix.length + end;
      const nextBoundary = oldBoundary + (unchangedPrefix ? 0 : shift);
      if (
        (!unchangedPrefix && (suffixLength === 0 || end < suffixStart)) ||
        end > Math.min(consumed, oldText.length) ||
        nextBoundary <= restartPrefix.length ||
        crossesCode(previous, oldBoundary, true) ||
        crossesCode(next, nextBoundary, true)
      ) {
        continue;
      }
      sourceBreaks.push(nextBoundary - restartPrefix.length);
    }
  }
  ctx.state.blockReplyScopeStart = {
    contentIndex: restartIndex,
    itemId: resolveAssistantStreamItemId({ contentIndex: restartIndex, message: next.message }),
  };
  ctx.blockChunker.reset(sourceBreaks);
  ctx.blockChunker.append(next.blockText.slice(restartPrefix.length));
}

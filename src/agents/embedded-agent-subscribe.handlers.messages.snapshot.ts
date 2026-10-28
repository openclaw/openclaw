import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import {
  createStreamingDirectiveAccumulator,
  splitTrailingDirective,
} from "../auto-reply/reply/streaming-directives.js";
import type { AssistantMessage } from "../llm/types.js";
import {
  assistantVisibleTextFilters,
  toolCallXmlTextFilter,
} from "../shared/text/assistant-visible-text.js";
import { findCodeRegions } from "../shared/text/code-regions.js";
import { findNativeToolMarkerTextBlocks } from "../shared/text/native-tool-marker.js";
import { applyTextFilters } from "../shared/text/text-projection.js";
import { sanitizeUserFacingText } from "./embedded-agent-helpers/sanitize-user-facing-text.js";
import {
  resolveAssistantStreamBlockIndex,
  resolveAssistantStreamItemId,
} from "./embedded-agent-subscribe.handlers.messages.stream.js";
import type {
  EmbeddedAgentSubscribeContext,
  EmbeddedAgentSubscribeState,
} from "./embedded-agent-subscribe.handlers.types.js";
import {
  createAssistantStreamBlockState,
  prepareAssistantVisibleText,
  stripDowngradedToolCallText,
} from "./embedded-agent-utils.js";

export function extractAssistantStreamSnapshot(
  ctx: EmbeddedAgentSubscribeContext,
  message: AssistantMessage,
  options?: {
    final?: boolean;
    throughIndex?: number;
    observedText?: string;
    nativeToolMarkerBlocks?: ReadonlySet<number>;
  },
) {
  const nativeToolMarkerBlocks =
    options?.nativeToolMarkerBlocks ?? findNativeToolMarkerTextBlocks(message);
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
  const state: EmbeddedAgentSubscribeState["partialBlockState"] = createAssistantStreamBlockState();
  let rawText = "";
  const protocol = createStreamingDirectiveAccumulator();
  const blockSources: { text: string; separator: string; finalAnswer: boolean }[] = [];
  const parts: { separator: string; index?: number }[] = [];
  const renderText = prepareAssistantVisibleText(observedMessage, (part, final, phase, index) => {
    // Native blocks can divide a tag or fence; only complete visible parts get a separator.
    const separator =
      protocol.sourceText && !state.pendingTagFragment && !state.pendingFenceFragment ? "\n" : "";
    const previousIndex = parts.at(-1)?.index;
    parts.push({ separator, index });
    rawText += part;
    const preparedStart = protocol.sourceText.length;
    protocol.consume(part, { final: final && options?.final !== false });
    const preparedPart = protocol.sourceText.slice(preparedStart);
    // Final prose preserves inline tag examples; generic streams still hide reasoning.
    const preparedFinal = phase === "final_answer" && !ctx.params.enforceFinalTag;
    const hidden = index !== undefined && nativeToolMarkerBlocks.has(index);
    // Hidden markers must not leave a pending tag that can consume later prose.
    const visible = hidden
      ? ""
      : preparedFinal
        ? `${separator}${preparedPart}`
        : ctx.stripBlockTags(`${separator}${preparedPart}`, state, {
            final: final && options?.final !== false,
          });
    const previous = blockSources.at(-1);
    if (
      previous &&
      previousIndex !== undefined &&
      index === previousIndex + 1 &&
      previous.finalAnswer === preparedFinal
    ) {
      previous.text += visible;
    } else {
      blockSources.push({
        text: visible.startsWith(separator) ? visible.slice(separator.length) : visible,
        separator,
        finalAnswer: preparedFinal,
      });
    }
    return hidden ? "" : preparedFinal ? preparedPart : visible;
  });
  const visibleBlockSource = blockSources
    .map(({ text, separator, finalAnswer }) => ({
      separator,
      text: finalAnswer
        ? sanitizeUserFacingText(
            applyTextFilters(
              text,
              assistantVisibleTextFilters("final-answer-delivery", options?.final === false, {
                preserveTrailingWhitespace: true,
              }),
            ),
            { streaming: options?.final === false },
          )
        : toolCallXmlTextFilter(
            { stripFunctionCallsXmlPayloads: true },
            options?.final === false,
          ).transform(stripDowngradedToolCallText(text, { preserveTrailingWhitespace: true })),
    }))
    // An empty observed tail still marks a native boundary for prefix reconciliation.
    .filter(
      ({ text }, index) =>
        text.trim() || (options?.observedText === "" && index === blockSources.length - 1),
    )
    .map(({ text, separator }, index) => `${index > 0 ? separator : ""}${text}`)
    .join("");
  const blockReply = parseReplyDirectives(
    options?.final === false
      ? splitTrailingDirective(visibleBlockSource, { preserveTrailingWhitespace: true }).text
      : visibleBlockSource,
    { preserveTrailingWhitespace: true },
  );
  let text: string | undefined;
  return {
    get text() {
      return (text ??= renderText());
    },
    rawText,
    state,
    parts,
    blockText: blockReply.text,
    message: observedMessage,
    nativeToolMarkerBlocks,
  };
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
    const prefix = extractAssistantStreamSnapshot(ctx, snapshot.message, {
      throughIndex: index - 1,
      final: false,
      nativeToolMarkerBlocks: snapshot.nativeToolMarkerBlocks,
    }).blockText;
    return prefix + (snapshot.parts.find((part) => part.index === index)?.separator ?? "");
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
  const crossesCode = (snapshot: typeof next, offset: number) => {
    if (offset <= 0 || offset >= snapshot.blockText.length) {
      return false;
    }
    const regions =
      snapshot === previous
        ? (oldCode ??= findCodeRegions(previous.blockText))
        : (nextCode ??= findCodeRegions(next.blockText));
    return regions.some((region) => region.start < offset && offset < region.end);
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
    ctx.blockChunker.replace(nextText, 0, retainedPrefix);
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
    ctx.blockChunker.replace(nextText, 0, retainedPrefix);
    return;
  }
  ctx.state.blockReplyScopeStart = {
    contentIndex: restartIndex,
    itemId: resolveAssistantStreamItemId({ contentIndex: restartIndex, message: next.message }),
  };
  ctx.blockChunker.reset([], restartPrefix.length);
  ctx.blockChunker.append(next.blockText.slice(restartPrefix.length));
}

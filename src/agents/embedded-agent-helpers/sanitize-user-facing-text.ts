/** Strips internal scaffolding from text before user-facing delivery. */
import {
  CURRENT_MESSAGE_MARKER,
  HISTORY_CONTEXT_MARKER,
  RECENT_HISTORY_CONTEXT_MARKER,
} from "../../auto-reply/reply/history.js";
import {
  createInboundMetadataProbe,
  stripInboundMetadata,
} from "../../auto-reply/reply/strip-inbound-meta.js";
import { coerceChatContentText } from "../../shared/chat-content.js";
import { escapeRegExp } from "../../shared/regexp.js";
import {
  assistantTraceTextFilter,
  legacyBracketToolCallTextFilter,
  minimaxToolCallTextFilter,
  plainToolCallTextFilter,
  toolCallXmlTextFilter,
} from "../../shared/text/assistant-visible-text.js";
import {
  findCodeRegions,
  isInsideCode,
  projectLinesOutsideCode,
  stripLinesOutsideCode,
} from "../../shared/text/code-regions.js";
import { finalTagTextFilter } from "../../shared/text/final-tags.js";
import {
  applyTextFilters,
  createConditionalTextProjector,
  duplicateParagraphTextFilter,
  leadingEmptyLinesTextFilter,
  type TextFilter,
  type TextProjector,
} from "../../shared/text/text-projection.js";
import { EXEC_NO_OUTPUT_PLACEHOLDER } from "../bash-tools.exec-output.js";
import { runtimeContextStreamingTextFilter } from "../internal-runtime-context-stream.js";
import { stripInternalRuntimeContext } from "../internal-runtime-context.js";

const TOOL_CALLS_OMITTED_TOKEN = "[tool calls omitted]";
const TOOL_CALLS_OMITTED_PLACEHOLDER_LINE_RE = /^[ \t]*\[tool calls omitted\][ \t]*$/i;

function isInternalPlaceholderLine(line: string): boolean {
  return (
    TOOL_CALLS_OMITTED_PLACEHOLDER_LINE_RE.test(line) || line.trim() === EXEC_NO_OUTPUT_PLACEHOLDER
  );
}

function stripInternalPlaceholderLines(text: string): string {
  if (
    !text.toLowerCase().includes(TOOL_CALLS_OMITTED_TOKEN) &&
    !text.includes(EXEC_NO_OUTPUT_PLACEHOLDER)
  ) {
    return text;
  }
  return stripLinesOutsideCode(text, isInternalPlaceholderLine);
}

// Quotes of an empty command transcript latch this stage for the rest of the reply. The canonical
// scan (and the Markdown code scan it needs) used to run on the whole reply for every delta: 17.9 s
// for a 16 KB reply that opens with a fenced transcript, 1.4 s for the same reply as a blockquote.
// Two cheap probes keep ordinary replies away from it: only a completed (or currently unfinished)
// line that the strip predicate accepts can change the output, and completed lines never change.
const internalPlaceholderLinesTextFilter: TextFilter = {
  transform: stripInternalPlaceholderLines,
  create: createInternalPlaceholderLinesProjector,
};

function createInternalPlaceholderLinesProjector(): TextProjector {
  let matched = false;
  let lineTail: string | null = "";
  let allowToolCallsOmitted = true;
  // Reject a nonmatching line until its newline; retain only a possible literal token prefix.
  const scanAppendedLines = (appended: string): boolean => {
    let start = 0;
    while (true) {
      const newline = appended.indexOf("\n", start);
      if (lineTail !== null) {
        const line = lineTail + appended.slice(start, newline === -1 ? undefined : newline);
        const candidate = line.trimStart();
        // Only the exec placeholder accepts Unicode padding; the bracket token accepts ASCII.
        allowToolCallsOmitted &&= /^[ \t]*$/u.test(line.slice(0, line.length - candidate.length));
        const normalized = candidate.replace(/\r$/u, "");
        if (
          isInternalPlaceholderLine(normalized) &&
          (allowToolCallsOmitted || normalized.trim() === EXEC_NO_OUTPUT_PLACEHOLDER)
        ) {
          return true;
        }
        lineTail =
          EXEC_NO_OUTPUT_PLACEHOLDER.startsWith(normalized) ||
          (allowToolCallsOmitted && TOOL_CALLS_OMITTED_TOKEN.startsWith(normalized.toLowerCase()))
            ? candidate
            : null;
      }
      if (newline === -1) {
        return false;
      }
      start = newline + 1;
      lineTail = "";
      allowToolCallsOmitted = true;
    }
  };
  return createConditionalTextProjector(
    stripInternalPlaceholderLines,
    (input) => {
      if (matched) {
        return true;
      }
      if (input.delta === null) {
        // A replacement can end mid-placeholder. Re-scan it through the append scanner so the
        // unfinished tail is carried into the next delta instead of being dropped.
        matched = false;
        lineTail = "";
        allowToolCallsOmitted = true;
        matched = scanAppendedLines(input.text);
        return matched;
      }
      matched = scanAppendedLines(input.delta);
      return matched;
    },
    // Completed lines never change again, so only the unfinished tail needs the canonical scan.
    (text, settledBoundary) =>
      projectLinesOutsideCode(text, isInternalPlaceholderLine, settledBoundary),
  );
}

const MARKDOWN_LINE_PREFIX =
  "[ \\t]*(?:(?:>|[-+*](?=[ \\t])|#{1,6}(?=[ \\t])|\\d{1,9}[.)](?=[ \\t]))[ \\t]*)*";

type VerifiedConversationContext = {
  readonly normalizedSource: string;
  sourceLines?: string[];
  firstSourceLine?: string;
  copiedPrompt?: RegExp;
  markdownWrapper?: RegExp;
  incompleteMarkdownWrapper?: RegExp;
};

const CONVERSATION_CONTEXT_MARKERS = [
  HISTORY_CONTEXT_MARKER,
  RECENT_HISTORY_CONTEXT_MARKER,
  CURRENT_MESSAGE_MARKER,
];

function hasConversationContextMarker(text: string): boolean {
  return CONVERSATION_CONTEXT_MARKERS.some((marker) => text.includes(marker));
}

function prepareVerifiedConversationContext(
  source: string | undefined,
): VerifiedConversationContext | undefined {
  if (!source || !hasConversationContextMarker(source)) {
    return undefined;
  }
  const sourceCodeRegions = findCodeRegions(source);
  const ownsConversationContext = CONVERSATION_CONTEXT_MARKERS.some((marker) => {
    let markerOffset = source.indexOf(marker);
    while (markerOffset !== -1) {
      const markerEnd = markerOffset + marker.length;
      const startsLine = markerOffset === 0 || source[markerOffset - 1] === "\n";
      const endsLine =
        markerEnd === source.length || source[markerEnd] === "\n" || source[markerEnd] === "\r";
      if (startsLine && endsLine && !isInsideCode(markerOffset, sourceCodeRegions)) {
        return true;
      }
      markerOffset = source.indexOf(marker, markerEnd);
    }
    return false;
  });
  if (!ownsConversationContext) {
    return undefined;
  }

  return { normalizedSource: source.replace(/\r\n?/gu, "\n") };
}

function stripVerifiedConversationContext(
  text: string,
  context: VerifiedConversationContext | undefined,
  streaming = false,
): string {
  if (!context) {
    return text;
  }
  const { normalizedSource } = context;
  let result = text;
  if (hasConversationContextMarker(text)) {
    if (!context.copiedPrompt) {
      const promptPattern = (context.sourceLines ??= normalizedSource.split("\n"))
        .map(escapeRegExp)
        .join(`(?:\\r\\n?|\\n)${MARKDOWN_LINE_PREFIX}`);
      context.copiedPrompt = new RegExp(`(?:^${MARKDOWN_LINE_PREFIX})?${promptPattern}`, "gmu");
    }
    // Markdown formatting does not make an exact owner-bound private prompt safe to disclose.
    result = text.replace(context.copiedPrompt, "");
  }
  if (!streaming) {
    return result;
  }

  const sourceStart = normalizedSource.charAt(0);
  const firstSourceLine = (context.firstSourceLine ??=
    normalizedSource.split("\n", 1)[0] ?? normalizedSource);
  const completedSourceStart = result.indexOf(firstSourceLine);
  // Anchor every completed prompt start; wrappers can be arbitrarily wide and markers can repeat.
  const searchStart =
    completedSourceStart === -1
      ? Math.max(0, result.length - normalizedSource.length * 2)
      : completedSourceStart;
  const markdownWrapper = (context.markdownWrapper ??= new RegExp(
    `^${MARKDOWN_LINE_PREFIX}$`,
    "u",
  ));
  const incompleteMarkdownWrapper = (context.incompleteMarkdownWrapper ??= new RegExp(
    `^${MARKDOWN_LINE_PREFIX}(?:[-+*]|#{1,6}|\\d{1,9}[.)]?)?$`,
    "u",
  ));
  let candidateStart = result.indexOf(sourceStart, searchStart);
  let completedCandidates = 0;
  while (candidateStart !== -1) {
    const remainingLength = result.length - candidateStart;
    const startsPromptLine =
      remainingLength >= firstSourceLine.length
        ? result.startsWith(firstSourceLine, candidateStart)
        : firstSourceLine.startsWith(result.slice(candidateStart));
    if (!startsPromptLine) {
      candidateStart = result.indexOf(sourceStart, candidateStart + 1);
      continue;
    }
    // Bound attacker-controlled full-marker floods without releasing an ambiguous private suffix.
    if (++completedCandidates > 16) {
      return result.slice(0, searchStart);
    }
    const suffix = result.slice(candidateStart).replace(/\r\n?/gu, "\n");
    const sourceLines = (context.sourceLines ??= normalizedSource.split("\n"));
    let lineIndex = 0;
    const unwrappedSuffix = suffix.replace(/\n([^\n]*)/gu, (_match, line: string) => {
      const sourceLine = sourceLines[++lineIndex];
      if (sourceLine === undefined) {
        return `\n${line}`;
      }
      if (!sourceLine) {
        return incompleteMarkdownWrapper.test(line) ? "\n" : `\n${line}`;
      }
      const sourceLineStart = sourceLine.charAt(0);
      let contentStart = line.indexOf(sourceLineStart);
      while (contentStart !== -1) {
        const content = line.slice(contentStart);
        if (sourceLine.startsWith(content) && markdownWrapper.test(line.slice(0, contentStart))) {
          return `\n${content}`;
        }
        contentStart = line.indexOf(sourceLineStart, contentStart + 1);
      }
      return incompleteMarkdownWrapper.test(line) ? "\n" : `\n${line}`;
    });
    if (
      (suffix.length < normalizedSource.length && normalizedSource.startsWith(suffix)) ||
      (unwrappedSuffix.length < normalizedSource.length &&
        normalizedSource.startsWith(unwrappedSuffix))
    ) {
      // A later stream update can complete private prompt bytes that cannot be retracted once sent.
      return result.slice(0, candidateStart);
    }
    candidateStart = result.indexOf(sourceStart, candidateStart + 1);
  }
  return result;
}

export function createVerifiedConversationContextStreamFilter(
  getConversationContext?: () => string | undefined,
): (delta: string) => string {
  let accumulatedText = "";
  let releasedText: string | null = "";
  let conversationContextSource: string | undefined;
  let preparedConversationContext: VerifiedConversationContext | undefined;
  return (delta) => {
    accumulatedText += delta;
    const conversationContext = getConversationContext?.();
    const sourceChanged = conversationContext !== conversationContextSource;
    if (sourceChanged) {
      preparedConversationContext = prepareVerifiedConversationContext(conversationContext?.trim());
      conversationContextSource = conversationContext;
    }
    const safeText = stripVerifiedConversationContext(
      accumulatedText,
      preparedConversationContext,
      true,
    );
    // An unchanged unowned source keeps the known prefix; changing ownership must recheck it.
    if (
      releasedText === null ||
      ((sourceChanged || preparedConversationContext) && !safeText.startsWith(releasedText))
    ) {
      releasedText = null;
      return "";
    }
    const newlySafeText = safeText.slice(releasedText.length);
    releasedText = safeText;
    return newlySafeText;
  };
}

// Share descriptors only; createTextProjection owns each stream's mutable state.
const userFacingFilters: Partial<
  Record<`${"normal" | "error"}${"" | "-stream"}`, readonly TextFilter[]>
> = {};

export function userFacingTextFilters(
  errorContext = false,
  streaming = false,
): readonly TextFilter[] {
  const key = `${errorContext ? "error" : "normal"}${streaming ? "-stream" : ""}` as const;
  return (userFacingFilters[key] ??= [
    finalTagTextFilter,
    streaming
      ? runtimeContextStreamingTextFilter
      : {
          transform: stripInternalRuntimeContext,
          // The canonical preflight also recognizes reflowed whitespace in carrier notices.
          create: () => createConditionalTextProjector(stripInternalRuntimeContext, () => true),
        },
    {
      transform: stripInboundMetadata,
      create: () =>
        createConditionalTextProjector(stripInboundMetadata, createInboundMetadataProbe()),
    },
    minimaxToolCallTextFilter(streaming),
    toolCallXmlTextFilter({ stripFunctionCallsXmlPayloads: true }),
    internalPlaceholderLinesTextFilter,
    ...(errorContext ? [assistantTraceTextFilter] : []),
    legacyBracketToolCallTextFilter,
    plainToolCallTextFilter,
    leadingEmptyLinesTextFilter,
    duplicateParagraphTextFilter,
  ]);
}

export function sanitizeUserFacingText(
  text: unknown,
  opts?: {
    errorContext?: boolean;
    conversationContext?: string;
    streaming?: boolean;
    preserveLeadingSourceBoundary?: boolean;
  },
): string {
  const raw = coerceChatContentText(text);
  if (!raw) {
    return raw;
  }
  const conversationContext = opts?.conversationContext?.trim();
  const withoutConversationContext =
    conversationContext && (opts?.streaming || hasConversationContextMarker(raw))
      ? stripVerifiedConversationContext(
          raw,
          prepareVerifiedConversationContext(conversationContext),
          opts?.streaming,
        )
      : raw;
  const filters = userFacingTextFilters(opts?.errorContext, opts?.streaming);
  return applyTextFilters(
    withoutConversationContext,
    opts?.preserveLeadingSourceBoundary && withoutConversationContext.startsWith("\n")
      ? filters.filter((filter) => filter !== leadingEmptyLinesTextFilter)
      : filters,
  );
}

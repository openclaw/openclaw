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
import { RUNTIME_CONTEXT_HEADER } from "../../llm/types.js";
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
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  OPENCLAW_RUNTIME_CONTEXT_NOTICE,
  stripInternalRuntimeContext,
} from "../internal-runtime-context.js";

const TOOL_CALLS_OMITTED_PLACEHOLDER_LINE_RE = /^[ \t]*\[tool calls omitted\][ \t]*$/i;

function stripInternalPlaceholderLines(text: string): string {
  if (
    !text.toLowerCase().includes("[tool calls omitted]") &&
    !text.includes(EXEC_NO_OUTPUT_PLACEHOLDER)
  ) {
    return text;
  }
  return stripLinesOutsideCode(
    text,
    (line) =>
      TOOL_CALLS_OMITTED_PLACEHOLDER_LINE_RE.test(line) ||
      line.trim() === EXEC_NO_OUTPUT_PLACEHOLDER,
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

// Line-delimited tokens that can begin a removable runtime-context block. Every one is a
// complete generated delimiter, so ordinary prose ("o", "<", "This context") never activates.
const RUNTIME_CONTEXT_STREAM_DELIMITERS = [
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  RUNTIME_CONTEXT_HEADER,
] as const;
const RUNTIME_CONTEXT_STREAM_DELIMITERS_LOWER = RUNTIME_CONTEXT_STREAM_DELIMITERS.map((token) =>
  token.toLowerCase(),
);
// The canonical carrier grammar accepts any whitespace between words, so a reflowed preface or
// notice still has to activate. The probe runs over a whitespace-normalized tail: a run of
// arbitrary width collapses to one space, so even a carrier split by hundreds of spaces keeps
// its recognized prefix without rescanning the accumulated reply.
const RUNTIME_CONTEXT_STREAM_CARRIER =
  /openclaw\s+runtime\s+(?:context|event)\b|this\s+context\s+is\s+runtime-generated\b/u;
// Longest probe ("this context is runtime-generated") plus the truncated head of the next word.
const RUNTIME_CONTEXT_STREAM_SCAN_LENGTH = 64;

function isWhitespaceOnly(value: string): boolean {
  return /^[ \t\r]*$/u.test(value);
}

/** Keep carrier words adjacent across whitespace runs, including runs split between deltas. */
function normalizeRuntimeContextScan(text: string): string {
  return text.replace(/\s+/gu, " ").toLowerCase();
}

/** Track whether everything published on the current line is still whitespace. */
function advanceLineStart(atLineStart: boolean, appended: string): boolean {
  if (appended === "") {
    return atLineStart;
  }
  const lastNewline = appended.lastIndexOf("\n");
  return lastNewline >= 0
    ? isWhitespaceOnly(appended.slice(lastNewline + 1))
    : atLineStart && isWhitespaceOnly(appended);
}

function hasRuntimeContextStreamTrigger(lowerText: string): boolean {
  if (RUNTIME_CONTEXT_STREAM_DELIMITERS_LOWER.some((token) => lowerText.includes(token))) {
    return true;
  }
  // Generated carrier words are never split internally, so the literal probes keep the
  // whitespace-tolerant regex off ordinary prose.
  return (
    (lowerText.includes("openclaw") || lowerText.includes("runtime-generated")) &&
    RUNTIME_CONTEXT_STREAM_CARRIER.test(lowerText)
  );
}

function isPartialRuntimeContextDelimiter(line: string): boolean {
  const tail = line.trim();
  return (
    tail.length > 0 &&
    RUNTIME_CONTEXT_STREAM_DELIMITERS.some(
      (delimiter) => tail.length < delimiter.length && delimiter.startsWith(tail),
    )
  );
}

function createRuntimeContextStreamProjector(): TextProjector {
  let active = false;
  let published = "";
  let atLineStart = true;
  let withheld = "";
  let scanTail = "";
  let prefixOnly = true;
  const result = (
    input: Parameters<TextProjector>[0],
    text: string,
    delta: string | null,
    previousPrefixOnly = prefixOnly,
  ): ReturnType<TextProjector> => {
    const retained = input.retained;
    // Without a complete carrier, the canonical scrub only truncates a suffix.
    // Replacements also require that prefix to have already been published.
    const mapped =
      prefixOnly &&
      previousPrefixOnly &&
      retained &&
      retained.prefix.length <= text.length &&
      (delta !== null || retained.prefix.length <= published.length)
        ? {
            prefix: retained.prefix,
            tail: retained.tail.slice(0, text.length - retained.prefix.length),
          }
        : undefined;
    published = text;
    return mapped
      ? { text, delta, retained: mapped }
      : text === input.text && delta === input.delta
        ? input
        : { text, delta };
  };
  const projector: TextProjector = (input) => {
    if (input.delta === null) {
      // Every subscriber projection starts with replace(previousStream?.raw ?? ""). Only a
      // replacement that itself carried carrier bytes may latch the scrub; an empty or
      // marker-free replacement has to keep the fast path or the per-delta cost comes back.
      const text = stripInternalRuntimeContext(input.text, { streaming: true });
      const scan = normalizeRuntimeContextScan(input.text);
      const previousPrefixOnly = prefixOnly;
      prefixOnly = !hasRuntimeContextStreamTrigger(scan);
      active = !prefixOnly || text !== input.text;
      scanTail = scan.slice(-RUNTIME_CONTEXT_STREAM_SCAN_LENGTH);
      atLineStart = isWhitespaceOnly(text.slice(text.lastIndexOf("\n") + 1));
      withheld = "";
      return result(input, text, null, previousPrefixOnly);
    }
    // Provider deltas have no size limit, so the trigger has to see the whole incoming chunk
    // before only the bounded overlap is retained; otherwise a coalesced private block could
    // publish its body without ever activating the scrub.
    const scan = normalizeRuntimeContextScan(scanTail + input.delta);
    scanTail = scan.slice(-RUNTIME_CONTEXT_STREAM_SCAN_LENGTH);
    if (hasRuntimeContextStreamTrigger(scan)) {
      active = true;
      prefixOnly = false;
    }
    if (active) {
      // A complete delimiter owns the rest of the reply: the canonical streaming scrub
      // latches so the context body can never follow it into the preview.
      const text = stripInternalRuntimeContext(input.text, { streaming: true });
      const delta = text.startsWith(published) ? text.slice(published.length) : null;
      atLineStart = text.length === 0 || text.endsWith("\n");
      withheld = "";
      return result(input, text, delta);
    }
    // A delimiter is removable only as a whole line, so a hold can start only where a
    // line starts - never from an ordinary line that already failed the prefix test.
    const complete = withheld + input.delta;
    const lastNewline = complete.lastIndexOf("\n");
    const candidate =
      lastNewline >= 0
        ? complete.slice(lastNewline + 1)
        : withheld || atLineStart
          ? complete
          : undefined;
    if (candidate !== undefined && isPartialRuntimeContextDelimiter(candidate)) {
      const prefix = complete.slice(0, complete.length - candidate.length);
      withheld = candidate;
      return result(input, prefix ? published + prefix : published, prefix);
    }
    if (withheld) {
      withheld = "";
      atLineStart = advanceLineStart(true, complete);
      return result(input, input.text, complete);
    }
    atLineStart = advanceLineStart(atLineStart, input.delta);
    return result(input, input.text, input.delta);
  };
  // Corrections still run the canonical replacement branch; retaining the instance
  // preserves only the prior output boundary needed to prove unchanged-prefix metadata.
  projector.canReplaceFrom = () => true;
  return projector;
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
      ? {
          transform: (text) => stripInternalRuntimeContext(text, { streaming: true }),
          create: createRuntimeContextStreamProjector,
        }
      : {
          transform: stripInternalRuntimeContext,
          activationTokens: [
            INTERNAL_RUNTIME_CONTEXT_BEGIN,
            INTERNAL_RUNTIME_CONTEXT_END,
            OPENCLAW_RUNTIME_CONTEXT_NOTICE,
            RUNTIME_CONTEXT_HEADER,
          ],
        },
    {
      transform: stripInboundMetadata,
      create: () =>
        createConditionalTextProjector(stripInboundMetadata, createInboundMetadataProbe()),
    },
    minimaxToolCallTextFilter(streaming),
    toolCallXmlTextFilter({ stripFunctionCallsXmlPayloads: true }),
    {
      transform: stripInternalPlaceholderLines,
      activationTokens: [EXEC_NO_OUTPUT_PLACEHOLDER, "[tool calls omitted]"],
    },
    ...(errorContext ? [assistantTraceTextFilter] : []),
    legacyBracketToolCallTextFilter,
    plainToolCallTextFilter,
    leadingEmptyLinesTextFilter,
    duplicateParagraphTextFilter,
  ]);
}

export function sanitizeUserFacingText(
  text: unknown,
  opts?: { errorContext?: boolean; conversationContext?: string; streaming?: boolean },
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
  return applyTextFilters(
    withoutConversationContext,
    userFacingTextFilters(opts?.errorContext, opts?.streaming),
  );
}

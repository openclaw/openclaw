export const INTERNAL_RUNTIME_CONTEXT_BEGIN = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
export const INTERNAL_RUNTIME_CONTEXT_END = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";

const ESCAPED_INTERNAL_RUNTIME_CONTEXT_BEGIN = "[[OPENCLAW_INTERNAL_CONTEXT_BEGIN]]";
const ESCAPED_INTERNAL_RUNTIME_CONTEXT_END = "[[OPENCLAW_INTERNAL_CONTEXT_END]]";

export const OPENCLAW_RUNTIME_CONTEXT_NOTICE =
  "This context is runtime-generated, not user-authored. Keep internal details private.";
export const OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER =
  "OpenClaw runtime context for the immediately preceding user message.";
export const OPENCLAW_RUNTIME_EVENT_HEADER = "OpenClaw runtime event.";
export const OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE = "openclaw.runtime-context";

const LEGACY_INTERNAL_CONTEXT_HEADER =
  ["OpenClaw runtime context (internal):", OPENCLAW_RUNTIME_CONTEXT_NOTICE, ""].join("\n") + "\n";

const LEGACY_INTERNAL_EVENT_MARKER = "[Internal task completion event]";
const LEGACY_INTERNAL_EVENT_SEPARATOR = "\n\n---\n\n";
const LEGACY_UNTRUSTED_RESULT_BEGIN = "<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>";
const LEGACY_UNTRUSTED_RESULT_END = "<<<END_UNTRUSTED_CHILD_RESULT>>>";

export function escapeInternalRuntimeContextDelimiters(value: string): string {
  return value
    .replaceAll(INTERNAL_RUNTIME_CONTEXT_BEGIN, ESCAPED_INTERNAL_RUNTIME_CONTEXT_BEGIN)
    .replaceAll(INTERNAL_RUNTIME_CONTEXT_END, ESCAPED_INTERNAL_RUNTIME_CONTEXT_END);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findDelimitedTokenIndex(text: string, token: string, from: number): number {
  const tokenRe = new RegExp(`(?:^|\\r?\\n)${escapeRegExp(token)}(?=\\r?\\n|$)`, "g");
  tokenRe.lastIndex = Math.max(0, from);
  const match = tokenRe.exec(text);
  if (!match) {
    return -1;
  }
  const prefixLength = match[0].length - token.length;
  return match.index + prefixLength;
}

function stripDelimitedBlock(text: string, begin: string, end: string): string {
  let next = text;
  for (;;) {
    const start = findDelimitedTokenIndex(next, begin, 0);
    if (start === -1) {
      return next;
    }

    let cursor = start + begin.length;
    let depth = 1;
    let finish = -1;
    while (depth > 0) {
      const nextBegin = findDelimitedTokenIndex(next, begin, cursor);
      const nextEnd = findDelimitedTokenIndex(next, end, cursor);
      if (nextEnd === -1) {
        break;
      }
      if (nextBegin !== -1 && nextBegin < nextEnd) {
        depth += 1;
        cursor = nextBegin + begin.length;
        continue;
      }
      depth -= 1;
      finish = nextEnd;
      cursor = nextEnd + end.length;
    }

    const before = next.slice(0, start).trimEnd();
    if (finish === -1 || depth !== 0) {
      return before;
    }
    const after = next.slice(finish + end.length).trimStart();
    next = before && after ? `${before}\n\n${after}` : `${before}${after}`;
  }
}

function findLegacyInternalEventEnd(text: string, start: number): number | null {
  if (!text.startsWith(LEGACY_INTERNAL_EVENT_MARKER, start)) {
    return null;
  }

  const resultBegin = text.indexOf(
    LEGACY_UNTRUSTED_RESULT_BEGIN,
    start + LEGACY_INTERNAL_EVENT_MARKER.length,
  );
  if (resultBegin === -1) {
    return null;
  }

  const resultEnd = text.indexOf(
    LEGACY_UNTRUSTED_RESULT_END,
    resultBegin + LEGACY_UNTRUSTED_RESULT_BEGIN.length,
  );
  if (resultEnd === -1) {
    return null;
  }

  const actionIndex = text.indexOf("\n\nAction:\n", resultEnd + LEGACY_UNTRUSTED_RESULT_END.length);
  if (actionIndex === -1) {
    return null;
  }

  const afterAction = actionIndex + "\n\nAction:\n".length;
  const nextEvent = text.indexOf(
    `${LEGACY_INTERNAL_EVENT_SEPARATOR}${LEGACY_INTERNAL_EVENT_MARKER}`,
    afterAction,
  );
  if (nextEvent !== -1) {
    return nextEvent;
  }

  const nextParagraph = text.indexOf("\n\n", afterAction);
  return nextParagraph === -1 ? text.length : nextParagraph;
}

function stripLegacyInternalRuntimeContext(text: string): string {
  let next = text;
  let searchFrom = 0;
  for (;;) {
    const headerStart = next.indexOf(LEGACY_INTERNAL_CONTEXT_HEADER, searchFrom);
    if (headerStart === -1) {
      return next;
    }

    const eventStart = headerStart + LEGACY_INTERNAL_CONTEXT_HEADER.length;
    if (!next.startsWith(LEGACY_INTERNAL_EVENT_MARKER, eventStart)) {
      searchFrom = eventStart;
      continue;
    }

    let blockEnd = findLegacyInternalEventEnd(next, eventStart);
    if (blockEnd == null) {
      const nextParagraph = next.indexOf("\n\n", eventStart + LEGACY_INTERNAL_EVENT_MARKER.length);
      blockEnd = nextParagraph === -1 ? next.length : nextParagraph;
    } else {
      while (
        next.startsWith(
          `${LEGACY_INTERNAL_EVENT_SEPARATOR}${LEGACY_INTERNAL_EVENT_MARKER}`,
          blockEnd,
        )
      ) {
        const nextEventStart = blockEnd + LEGACY_INTERNAL_EVENT_SEPARATOR.length;
        const nextEventEnd = findLegacyInternalEventEnd(next, nextEventStart);
        if (nextEventEnd == null) {
          break;
        }
        blockEnd = nextEventEnd;
      }
    }

    const before = next.slice(0, headerStart).trimEnd();
    const after = next.slice(blockEnd).trimStart();
    next = before && after ? `${before}\n\n${after}` : `${before}${after}`;
    searchFrom = Math.max(0, before.length - 1);
  }
}

function findRuntimeContextPromptHeader(text: string, from: number): RegExpExecArray | null {
  const headerRe = new RegExp(
    `${escapeRegExp(OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER)}|${escapeRegExp(OPENCLAW_RUNTIME_EVENT_HEADER)}`,
    "g",
  );
  headerRe.lastIndex = from;
  for (;;) {
    const match = headerRe.exec(text);
    if (!match) {
      return null;
    }
    const lineStart = match.index === 0 || /\r?\n$/.test(text.slice(0, match.index));
    const afterHeader = match.index + match[0].length;
    const lineEnd = afterHeader >= text.length || /^\r?\n/.test(text.slice(afterHeader));
    if (lineStart && lineEnd) {
      return match;
    }
  }
}

function findLineEnd(text: string, from: number): number {
  const newline = text.indexOf("\n", from);
  return newline === -1 ? text.length : newline;
}

function skipBlankLines(text: string, from: number): number {
  let cursor = from;
  for (;;) {
    const lineEnd = findLineEnd(text, cursor);
    const line = text.slice(cursor, lineEnd).replace(/\r$/, "");
    if (line.trim() !== "") {
      return cursor;
    }
    if (lineEnd >= text.length) {
      return text.length;
    }
    cursor = lineEnd + 1;
  }
}

function readParagraph(text: string, from: number): { end: number; text: string } {
  const nextBreak = text.indexOf("\n\n", from);
  const end = nextBreak === -1 ? text.length : nextBreak;
  return { end, text: text.slice(from, end).trim() };
}

function isMetadataHeading(paragraph: string): boolean {
  return /^(?:Conversation info \(untrusted metadata\):|Sender \(untrusted metadata\):|Replied message \(untrusted, for context\):|Inbound Context \(trusted metadata\):)$/u.test(
    paragraph,
  );
}

function isStructuredMetadataPayload(paragraph: string): boolean {
  return /^(?:```(?:json)?\s*[\s\S]*```\s*|\{[\s\S]*\}\s*)$/u.test(paragraph);
}

function consumeMetadataSection(text: string, cursor: number): number | null {
  const heading = readParagraph(text, cursor);
  const firstLineEnd = heading.text.indexOf("\n");
  const firstLine = firstLineEnd === -1 ? heading.text : heading.text.slice(0, firstLineEnd);
  if (!isMetadataHeading(firstLine)) {
    return null;
  }

  if (firstLineEnd !== -1) {
    const inlinePayload = heading.text.slice(firstLineEnd + 1).trim();
    if (isStructuredMetadataPayload(inlinePayload)) {
      return heading.end;
    }
  }

  let nextCursor = skipBlankLines(text, heading.end);
  if (nextCursor >= text.length) {
    return heading.end;
  }

  const payload = readParagraph(text, nextCursor);
  if (!isStructuredMetadataPayload(payload.text)) {
    return heading.end;
  }
  nextCursor = payload.end;

  return nextCursor;
}

function isAsyncCompletionIntro(paragraph: string): boolean {
  return paragraph.startsWith(
    "An async command you ran earlier has completed. The command completion details are:",
  );
}

function isAsyncCompletionScaffold(paragraph: string): boolean {
  return (
    paragraph.startsWith("The command completion details are:") ||
    paragraph.startsWith("Exec completed (") ||
    paragraph.startsWith("Please relay the command output to the user")
  );
}

function consumeExecStateSection(text: string, cursor: number): number | null {
  const heading = readParagraph(text, cursor);
  if (heading.text !== "Current Exec Session State") {
    return null;
  }

  let nextCursor = skipBlankLines(text, heading.end);
  while (nextCursor < text.length) {
    const paragraph = readParagraph(text, nextCursor);
    if (
      !paragraph.text.startsWith("Current session exec defaults:") &&
      !paragraph.text.startsWith("Current elevated level:") &&
      !paragraph.text.startsWith("If the user asks to run a command,")
    ) {
      break;
    }
    nextCursor = skipBlankLines(text, paragraph.end);
  }

  return nextCursor;
}

function consumeModernRuntimeContextWrapperSection(
  text: string,
  cursor: number,
  state: { sawAsyncCompletionIntro: boolean },
): number | null {
  const metadataEnd = consumeMetadataSection(text, cursor);
  if (metadataEnd !== null) {
    return metadataEnd;
  }

  const execStateEnd = consumeExecStateSection(text, cursor);
  if (execStateEnd !== null) {
    return execStateEnd;
  }

  const paragraph = readParagraph(text, cursor);
  if (!paragraph.text) {
    return null;
  }

  if (isAsyncCompletionIntro(paragraph.text)) {
    state.sawAsyncCompletionIntro = true;
    return paragraph.end;
  }

  if (state.sawAsyncCompletionIntro && isAsyncCompletionScaffold(paragraph.text)) {
    return paragraph.end;
  }

  return null;
}

function stripRuntimeContextPromptBlocks(text: string): string {
  let next = text;
  let searchFrom = 0;
  for (;;) {
    const match = findRuntimeContextPromptHeader(next, searchFrom);
    if (!match) {
      return next;
    }

    const headerStart = match.index;
    let cursor = findLineEnd(next, headerStart) + 1;
    const noticeLineEnd = findLineEnd(next, cursor);
    const noticeLine = next.slice(cursor, noticeLineEnd).replace(/\r$/, "").trim();
    if (noticeLine !== OPENCLAW_RUNTIME_CONTEXT_NOTICE) {
      searchFrom = cursor;
      continue;
    }

    cursor = noticeLineEnd >= next.length ? next.length : noticeLineEnd + 1;
    cursor = skipBlankLines(next, cursor);

    const state = { sawAsyncCompletionIntro: false };
    for (let consumed = 0; consumed < 50 && cursor < next.length; consumed += 1) {
      const nextCursor = consumeModernRuntimeContextWrapperSection(next, cursor, state);
      if (nextCursor === null) {
        break;
      }
      cursor = skipBlankLines(next, nextCursor);
    }

    const before = next.slice(0, headerStart).trimEnd();
    const after = next.slice(cursor).trimStart();
    next = before && after ? `${before}\n\n${after}` : `${before}${after}`;
    searchFrom = Math.max(0, before.length - 1);
  }
}

export function stripInternalRuntimeContext(text: string): string {
  if (!text) {
    return text;
  }
  const withoutDelimitedBlocks = stripDelimitedBlock(
    text,
    INTERNAL_RUNTIME_CONTEXT_BEGIN,
    INTERNAL_RUNTIME_CONTEXT_END,
  );
  return stripRuntimeContextPromptBlocks(stripLegacyInternalRuntimeContext(withoutDelimitedBlocks));
}

export function hasInternalRuntimeContext(text: string): boolean {
  if (!text) {
    return false;
  }
  return (
    findDelimitedTokenIndex(text, INTERNAL_RUNTIME_CONTEXT_BEGIN, 0) !== -1 ||
    text.includes(LEGACY_INTERNAL_CONTEXT_HEADER) ||
    text.includes(
      `${OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER}\n${OPENCLAW_RUNTIME_CONTEXT_NOTICE}`,
    ) ||
    text.includes(`${OPENCLAW_RUNTIME_EVENT_HEADER}\n${OPENCLAW_RUNTIME_CONTEXT_NOTICE}`)
  );
}

function isOpenClawRuntimeContextCustomMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const candidate = message as { role?: unknown; customType?: unknown };
  return (
    candidate.role === "custom" && candidate.customType === OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE
  );
}

export function stripRuntimeContextCustomMessages<T>(messages: T[]): T[] {
  if (!messages.some(isOpenClawRuntimeContextCustomMessage)) {
    return messages;
  }
  return messages.filter((message) => !isOpenClawRuntimeContextCustomMessage(message));
}

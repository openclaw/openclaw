export const INTERNAL_RUNTIME_CONTEXT_BEGIN = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
export const INTERNAL_RUNTIME_CONTEXT_END = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";

const ESCAPED_INTERNAL_RUNTIME_CONTEXT_BEGIN = "[[OPENCLAW_INTERNAL_CONTEXT_BEGIN]]";
const ESCAPED_INTERNAL_RUNTIME_CONTEXT_END = "[[OPENCLAW_INTERNAL_CONTEXT_END]]";

const LEGACY_INTERNAL_CONTEXT_HEADER =
  [
    "OpenClaw runtime context (internal):",
    "This context is runtime-generated, not user-authored. Keep internal details private.",
    "",
  ].join("\n") + "\n";

const LEGACY_INTERNAL_EVENT_MARKER = "[Internal task completion event]";
const LEGACY_INTERNAL_EVENT_SEPARATOR = "\n\n---\n\n";
const LEGACY_UNTRUSTED_RESULT_BEGIN = "<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>";
const LEGACY_UNTRUSTED_RESULT_END = "<<<END_UNTRUSTED_CHILD_RESULT>>>";

// Headers used by `buildRuntimeContextMessageContent` in
// src/agents/pi-embedded-runner/run/runtime-context-prompt.ts. The Pi runtime
// converts the resulting custom-message into a user-role LLM turn, so any
// model that ignores the privacy notice can echo these lines verbatim into
// its visible reply. Strip them on outbound the same way we strip the
// legacy `OpenClaw runtime context (internal):` header.
const RUNTIME_CONTEXT_NEXT_TURN_PREFACE_HEADER =
  "OpenClaw runtime context for the immediately preceding user message.";
const RUNTIME_CONTEXT_RUNTIME_EVENT_PREFACE_HEADER = "OpenClaw runtime event.";
const RUNTIME_CONTEXT_PREFACE_NOTICE_LINE =
  "This context is runtime-generated, not user-authored. Keep internal details private.";

const RUNTIME_CONTEXT_PREFACE_HEADERS: readonly string[] = [
  RUNTIME_CONTEXT_NEXT_TURN_PREFACE_HEADER,
  RUNTIME_CONTEXT_RUNTIME_EVENT_PREFACE_HEADER,
];

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

// Returns the index of the first line-start occurrence of `header` at or
// after `from`, where "line-start" means either the very beginning of the
// string or immediately after a newline. Returns -1 if no such occurrence
// exists.
function findLineStartIndex(text: string, header: string, from: number): number {
  let cursor = Math.max(0, from);
  for (;;) {
    const idx = text.indexOf(header, cursor);
    if (idx === -1) {
      return -1;
    }
    if (idx === 0 || text.charCodeAt(idx - 1) === 0x0a /* \n */) {
      return idx;
    }
    cursor = idx + 1;
  }
}

// Returns the byte offset just past the privacy-notice line that follows
// `headerIdx`, or null if the header isn't immediately followed by a newline
// + the exact privacy-notice line + an end-of-line boundary. Tolerates an
// optional `\r` before the newline that joins header → notice. Rejects
// matches where extra characters follow the notice on the same line, so
// model echoes like `"...Keep internal details private. [ack]"` are left
// alone instead of being half-stripped.
function findRuntimeContextPrefaceEnd(text: string, headerIdx: number, header: string): number | null {
  let cursor = headerIdx + header.length;
  if (text.charCodeAt(cursor) === 0x0d /* \r */) {
    cursor += 1;
  }
  if (text.charCodeAt(cursor) !== 0x0a /* \n */) {
    return null;
  }
  cursor += 1;
  if (text.slice(cursor, cursor + RUNTIME_CONTEXT_PREFACE_NOTICE_LINE.length) !==
      RUNTIME_CONTEXT_PREFACE_NOTICE_LINE) {
    return null;
  }
  const endOfNotice = cursor + RUNTIME_CONTEXT_PREFACE_NOTICE_LINE.length;
  if (endOfNotice < text.length) {
    const charAfter = text.charCodeAt(endOfNotice);
    if (charAfter !== 0x0a /* \n */ && charAfter !== 0x0d /* \r */) {
      return null;
    }
  }
  return endOfNotice;
}

function hasRuntimeContextPreface(text: string): boolean {
  for (const header of RUNTIME_CONTEXT_PREFACE_HEADERS) {
    let cursor = 0;
    for (;;) {
      const headerIdx = findLineStartIndex(text, header, cursor);
      if (headerIdx === -1) {
        break;
      }
      if (findRuntimeContextPrefaceEnd(text, headerIdx, header) !== null) {
        return true;
      }
      cursor = headerIdx + header.length;
    }
  }
  return false;
}

function stripRuntimeContextPreface(text: string): string {
  let next = text;
  for (const header of RUNTIME_CONTEXT_PREFACE_HEADERS) {
    let searchFrom = 0;
    for (;;) {
      const headerIdx = findLineStartIndex(next, header, searchFrom);
      if (headerIdx === -1) {
        break;
      }
      const blockEnd = findRuntimeContextPrefaceEnd(next, headerIdx, header);
      if (blockEnd === null) {
        searchFrom = headerIdx + header.length;
        continue;
      }
      const before = next.slice(0, headerIdx).replace(/[ \t]*\r?\n+$/, "");
      const after = next.slice(blockEnd).replace(/^\r?\n+[ \t]*/, "");
      const joiner = before && after ? "\n\n" : "";
      next = `${before}${joiner}${after}`;
      searchFrom = before.length;
    }
  }
  return next;
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
  const withoutLegacyHeader = stripLegacyInternalRuntimeContext(withoutDelimitedBlocks);
  return stripRuntimeContextPreface(withoutLegacyHeader);
}

export function hasInternalRuntimeContext(text: string): boolean {
  if (!text) {
    return false;
  }
  return (
    findDelimitedTokenIndex(text, INTERNAL_RUNTIME_CONTEXT_BEGIN, 0) !== -1 ||
    text.includes(LEGACY_INTERNAL_CONTEXT_HEADER) ||
    hasRuntimeContextPreface(text)
  );
}

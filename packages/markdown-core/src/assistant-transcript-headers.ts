export type AssistantTranscriptRole = "assistant" | "developer" | "system" | "user";

export type AssistantTranscriptRoleHeaderKind =
  | "angle_role_header"
  | "role_timestamp_bracket"
  | "timestamp_role_colon";

export type AssistantTranscriptRoleHeaderSpan = {
  start: number;
  end: number;
  kind: AssistantTranscriptRoleHeaderKind;
  role: AssistantTranscriptRole;
};

type TextRange = {
  start: number;
  end: number;
};

const TRANSCRIPT_ROLES: readonly AssistantTranscriptRole[] = [
  "assistant",
  "developer",
  "system",
  "user",
];

function isHorizontalWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t";
}

function isLineTrailingWhitespace(char: string | undefined): boolean {
  return isHorizontalWhitespace(char) || char === "\r";
}

function skipHorizontalWhitespace(text: string, start: number, end: number): number {
  let cursor = start;
  while (cursor < end && isHorizontalWhitespace(text[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function matchRoleAt(
  text: string,
  start: number,
  end: number,
): { role: AssistantTranscriptRole; end: number } | null {
  for (const role of TRANSCRIPT_ROLES) {
    const roleEnd = start + role.length;
    if (roleEnd <= end && text.slice(start, roleEnd).toLowerCase() === role) {
      return { role, end: roleEnd };
    }
  }
  return null;
}

function findDelimitedEnd(
  text: string,
  contentStart: number,
  lineEnd: number,
  close: "]" | ">",
  minContentLength: number,
): number | null {
  const searchEnd = Math.min(lineEnd, contentStart + 160 + 1);
  for (let index = contentStart; index < searchEnd; index += 1) {
    const char = text[index];
    // Paired backticks are parsed as code and excluded earlier. An unmatched
    // delimiter leaves a header that target renderers cannot wrap consistently.
    if (char === "`") {
      return null;
    }
    if (char === close) {
      return index - contentStart >= minContentLength ? index + 1 : null;
    }
  }
  return null;
}

function isHeaderBoundary(char: string | undefined): boolean {
  return char === undefined || isLineTrailingWhitespace(char) || char === ":" || char === "：";
}

function matchRoleHeader(
  text: string,
  start: number,
  lineEnd: number,
): AssistantTranscriptRoleHeaderSpan | null {
  const opener = text[start];
  let roleStart = start;
  if (opener === "[") {
    const bracketEnd = findDelimitedEnd(text, start + 1, lineEnd, "]", 4);
    if (!bracketEnd) {
      return null;
    }
    roleStart = skipHorizontalWhitespace(text, bracketEnd, lineEnd);
  } else if (opener === "<") {
    roleStart = skipHorizontalWhitespace(text, start + 1, lineEnd);
  }
  const role = matchRoleAt(text, roleStart, lineEnd);
  if (!role) {
    return null;
  }

  let end: number | null;
  let kind: AssistantTranscriptRoleHeaderKind;
  if (opener === "[") {
    const colonAt = skipHorizontalWhitespace(text, role.end, lineEnd);
    if (text[colonAt] !== ":" && text[colonAt] !== "：") {
      return null;
    }
    end = colonAt + 1;
    kind = "timestamp_role_colon";
  } else {
    if (opener === "<") {
      const boundary = text[role.end];
      if (boundary !== ">" && !isHorizontalWhitespace(boundary)) {
        return null;
      }
      end = findDelimitedEnd(text, role.end, lineEnd, ">", 0);
      kind = "angle_role_header";
    } else {
      const bracketStart = skipHorizontalWhitespace(text, role.end, lineEnd);
      if (text[bracketStart] !== "[") {
        return null;
      }
      end = findDelimitedEnd(text, bracketStart + 1, lineEnd, "]", 1);
      kind = "role_timestamp_bracket";
    }
    if (!end || !isHeaderBoundary(text[end])) {
      return null;
    }
  }
  return { start, end, kind, role: role.role };
}

function rangesOverlap(left: TextRange, right: TextRange): boolean {
  return left.start < right.end && left.end > right.start;
}

/** Finds supported transcript-role headers in parser-visible text. */
export function findAssistantTranscriptRoleHeaderSpans(
  text: string,
  excludedRanges: readonly TextRange[] = [],
): AssistantTranscriptRoleHeaderSpan[] {
  if (!text.includes("[") && !text.includes("<")) {
    return [];
  }
  const spans: AssistantTranscriptRoleHeaderSpan[] = [];
  const sortedExcludedRanges = [...excludedRanges].toSorted(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let excludedRangeIndex = 0;
  let lineStart = 0;
  while (lineStart < text.length) {
    const newlineAt = text.indexOf("\n", lineStart);
    const lineEnd = newlineAt === -1 ? text.length : newlineAt;
    const contentStart = skipHorizontalWhitespace(text, lineStart, lineEnd);
    const span = matchRoleHeader(text, contentStart, lineEnd);
    if (span) {
      for (;;) {
        const excludedRange = sortedExcludedRanges[excludedRangeIndex];
        if (!excludedRange || excludedRange.end > span.start) {
          break;
        }
        excludedRangeIndex += 1;
      }
      const excludedRange = sortedExcludedRanges[excludedRangeIndex];
      if (!excludedRange || !rangesOverlap(span, excludedRange)) {
        spans.push(span);
      }
    }
    if (newlineAt === -1) {
      break;
    }
    lineStart = newlineAt + 1;
  }
  return spans;
}

export const DAILY_MEMORY_FLUSH_MAX_APPEND_CHARS = 800;
export const DAILY_MEMORY_FLUSH_MAX_APPEND_LINES = 3;
export const DAILY_MEMORY_FLUSH_MAX_EXISTING_FILE_BYTES = 16 * 1024 * 1024;
const DAILY_MEMORY_FLUSH_MAX_LINE_CHARS = 500;
const MARKDOWN_HEADING_OR_SCAFFOLD_LINE_RE = /^(?:#{1,6}(?:\s|$)|=+$|-{2,}$)/;

export type DailyMemoryFlushSemanticPolicy = {
  rejectHeadings?: boolean;
  deduplicateLines?: boolean;
};

export type PreparedMemoryFlushAppend =
  | {
      status: "accepted";
      content: string;
      appendedLines: number;
      appendChars: number;
      skippedDuplicateLines: number;
    }
  | {
      status: "skipped_duplicate";
      content: "";
      skippedDuplicateLines: number;
    };

export function memoryFlushAppendRejected(message: string): Error {
  return new Error(`Memory flush append rejected: ${message}`);
}

function splitLines(content: string): string[] {
  return content
    .trim()
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeLineKey(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

function assertHardBounds(lines: readonly string[]): string {
  if (lines.length === 0) {
    throw memoryFlushAppendRejected("content must include at least one non-empty line.");
  }
  if (lines.length > DAILY_MEMORY_FLUSH_MAX_APPEND_LINES) {
    throw memoryFlushAppendRejected(
      `too many lines (${lines.length}; max ${DAILY_MEMORY_FLUSH_MAX_APPEND_LINES}). Write 1-3 short pointer lines only.`,
    );
  }
  const longLine = lines.find((line) => line.length > DAILY_MEMORY_FLUSH_MAX_LINE_CHARS);
  if (longLine) {
    throw memoryFlushAppendRejected(
      `line too long (${longLine.length} chars; max ${DAILY_MEMORY_FLUSH_MAX_LINE_CHARS}). Write a short pointer instead of a transcript-style narrative.`,
    );
  }
  const content = lines.join("\n");
  if (content.length > DAILY_MEMORY_FLUSH_MAX_APPEND_CHARS) {
    throw memoryFlushAppendRejected(
      `content too large (${content.length} chars; max ${DAILY_MEMORY_FLUSH_MAX_APPEND_CHARS}). Write 1-3 short pointer lines only.`,
    );
  }
  return content;
}

export function prepareDailyMemoryFlushAppend(params: {
  content: string;
  existingContent: string;
  semanticPolicy?: DailyMemoryFlushSemanticPolicy;
}): PreparedMemoryFlushAppend {
  const proposedLines = splitLines(params.content);
  // Structural bounds are unconditional and apply before optional semantic filtering.
  // This keeps the accepted input envelope fixed regardless of operator policy.
  assertHardBounds(proposedLines);

  if (
    params.semanticPolicy?.rejectHeadings === true &&
    proposedLines.some((line) => MARKDOWN_HEADING_OR_SCAFFOLD_LINE_RE.test(line))
  ) {
    throw memoryFlushAppendRejected(
      "markdown headings or daily-memory scaffolds are disabled by policy; append only new note lines.",
    );
  }

  let newLines = proposedLines;
  let skippedDuplicateLines = 0;
  if (params.semanticPolicy?.deduplicateLines === true) {
    const existingKeys = new Set(splitLines(params.existingContent).map(normalizeLineKey));
    newLines = [];
    for (const line of proposedLines) {
      const key = normalizeLineKey(line);
      if (existingKeys.has(key)) {
        skippedDuplicateLines += 1;
        continue;
      }
      existingKeys.add(key);
      newLines.push(line);
    }
    if (newLines.length === 0) {
      return { status: "skipped_duplicate", content: "", skippedDuplicateLines };
    }
  }

  const content = newLines.join("\n");
  return {
    status: "accepted",
    content,
    appendedLines: newLines.length,
    appendChars: content.length,
    skippedDuplicateLines,
  };
}

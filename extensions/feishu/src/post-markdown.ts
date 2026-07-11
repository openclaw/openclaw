// Feishu post-message markdown helpers.

type MarkdownFence = {
  marker: "`" | "~";
  length: number;
};

function readOpeningMarkdownFence(line: string): MarkdownFence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(stripMarkdownBlockQuoteContainers(line));
  const fence = match?.[1];
  if (!fence) {
    return undefined;
  }
  return {
    marker: fence[0] as "`" | "~",
    length: fence.length,
  };
}

function isClosingMarkdownFence(line: string, activeFence: MarkdownFence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(stripMarkdownBlockQuoteContainers(line));
  const fence = match?.[1];
  return Boolean(fence && fence[0] === activeFence.marker && fence.length >= activeFence.length);
}

// Mirrors markdown-it's GFM table shape so raw-table mode does not
// inject paragraph breaks inside syntax the shared parser treats as one table.
function splitMarkdownTableColumns(line: string): string[] {
  const columns: string[] = [];
  let current = "";
  let escaped = false;
  for (const char of line) {
    if (char === "|" && !escaped) {
      columns.push(current);
      current = "";
    } else {
      current += char;
    }
    escaped = char === "\\" && !escaped;
    if (char !== "\\") {
      escaped = false;
    }
  }
  columns.push(current);
  if (columns[0]?.trim() === "") {
    columns.shift();
  }
  if (columns.at(-1)?.trim() === "") {
    columns.pop();
  }
  return columns;
}

function countMarkdownColumns(line: string): number {
  const trimmed = line.trim();
  if (!trimmed.includes("|") || /^ {4}/.test(line)) {
    return 0;
  }
  return splitMarkdownTableColumns(trimmed).length;
}

function hasMarkdownTableDelimiter(line: string, columnCount: number): boolean {
  const trimmed = line.trim();
  if (columnCount === 0 || trimmed.length < 2 || /^ {4}/.test(line)) {
    return false;
  }
  if (!/^[|:\-\t ]+$/.test(trimmed)) {
    return false;
  }
  if (trimmed[0] === "-" && /[ \t]/.test(trimmed[1] ?? "")) {
    return false;
  }
  const cells = trimmed.split("|");
  const alignments: string[] = [];
  for (let index = 0; index < cells.length; index++) {
    const cell = cells[index]?.trim() ?? "";
    if (!cell) {
      if (index === 0 || index === cells.length - 1) {
        continue;
      }
      return false;
    }
    if (!/^:?-+:?$/.test(cell)) {
      return false;
    }
    alignments.push(cell);
  }
  return alignments.length === columnCount;
}

function startsMarkdownTableTerminator(line: string): boolean {
  return (
    /^ {0,3}(`{3,}|~{3,})/.test(line) ||
    /^ {0,3}#{1,6}(?:\s|$)/.test(line) ||
    /^ {0,3}>/.test(line) ||
    /^ {0,3}(?:[-+*]\s+|\d{1,9}[.)]\s+)/.test(line) ||
    /^ {0,3}(?:(?:[-*_][ \t]*){3,})$/.test(line)
  );
}

function stripMarkdownBlockQuoteContainers(line: string): string {
  let remaining = line;
  while (true) {
    const match = /^ {0,3}> ?/.exec(remaining);
    if (!match) {
      return remaining;
    }
    remaining = remaining.slice(match[0].length);
  }
}

function isMarkdownBlankLine(line: string): boolean {
  return stripMarkdownBlockQuoteContainers(line).trim().length === 0;
}

function isIndentedMarkdownCodeLine(line: string): boolean {
  return /^(?: {4}|\t)/.test(stripMarkdownBlockQuoteContainers(line));
}

// Indented CommonMark code is literal too; only prose line breaks should
// receive the extra paragraph separator Feishu needs for visible wrapping.
function resolveIndentedMarkdownCodeBreaks(lines: string[]): Set<number> {
  const breaks = new Set<number>();
  const codeBlockLines = new Set<number>();
  let inCodeBlock = false;
  let canStartCodeBlock = true;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? "";
    const isBlank = isMarkdownBlankLine(line);
    const isIndentedCodeLine = isIndentedMarkdownCodeLine(line);
    if (inCodeBlock && !isBlank && !isIndentedCodeLine) {
      inCodeBlock = false;
    }
    if (!inCodeBlock && isIndentedCodeLine && canStartCodeBlock) {
      inCodeBlock = true;
    }
    if (inCodeBlock && (isIndentedCodeLine || isBlank)) {
      codeBlockLines.add(lineIndex);
    }
    canStartCodeBlock = isBlank || inCodeBlock;
  }
  for (let lineIndex = 0; lineIndex < lines.length - 1; lineIndex++) {
    if (codeBlockLines.has(lineIndex) && codeBlockLines.has(lineIndex + 1)) {
      breaks.add(lineIndex);
    }
  }
  return breaks;
}

function resolveRawMarkdownTableBreaks(lines: string[]): Set<number> {
  const breaks = new Set<number>();
  for (let lineIndex = 0; lineIndex < lines.length - 1; lineIndex++) {
    const columnCount = countMarkdownColumns(lines[lineIndex] ?? "");
    if (!hasMarkdownTableDelimiter(lines[lineIndex + 1] ?? "", columnCount)) {
      continue;
    }
    let tableEnd = lineIndex + 2;
    while (tableEnd < lines.length) {
      const line = lines[tableEnd] ?? "";
      if (!line.trim() || /^ {4}/.test(line) || startsMarkdownTableTerminator(line)) {
        break;
      }
      tableEnd++;
    }
    for (let tableLine = lineIndex; tableLine < tableEnd - 1; tableLine++) {
      breaks.add(tableLine);
    }
    lineIndex = tableEnd - 1;
  }
  return breaks;
}

export function materializeFeishuPostMarkdownLineBreaks(text: string): string {
  const parts = text.split(/(\r\n|\n|\r)/);
  const lines = parts.filter((_, index) => index % 2 === 0);
  const indentedCodeBreaks = resolveIndentedMarkdownCodeBreaks(lines);
  const tableBreaks = resolveRawMarkdownTableBreaks(lines);
  let activeFence: MarkdownFence | undefined;
  let result = "";
  for (let index = 0; index < parts.length; index += 2) {
    const lineIndex = index / 2;
    const line = parts[index] ?? "";
    const separator = parts[index + 1] ?? "";
    const wasInFence = Boolean(activeFence);
    let isFenceBoundary = false;
    if (activeFence) {
      if (isClosingMarkdownFence(line, activeFence)) {
        activeFence = undefined;
        isFenceBoundary = true;
      }
    } else {
      activeFence = readOpeningMarkdownFence(line);
      isFenceBoundary = Boolean(activeFence);
    }
    result += line;
    if (!separator) {
      continue;
    }
    const nextLine = parts[index + 2] ?? "";
    const lineIsBlank = isMarkdownBlankLine(line);
    const nextLineIsBlank = isMarkdownBlankLine(nextLine);
    const keepSingleBreak =
      wasInFence ||
      isFenceBoundary ||
      Boolean(readOpeningMarkdownFence(nextLine)) ||
      indentedCodeBreaks.has(lineIndex) ||
      tableBreaks.has(lineIndex) ||
      lineIsBlank ||
      nextLineIsBlank;
    result += keepSingleBreak ? separator : `${separator}${separator}`;
  }
  return result;
}

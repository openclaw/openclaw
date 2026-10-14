import { detectLineEnding } from "../../line-endings.js";

export interface TextReplacement {
  matchIndex: number;
  matchLength: number;
  newText: string;
}

interface LineSpan {
  start: number;
  end: number;
}

function getLineSpans(content: string): LineSpan[] {
  let offset = 0;
  return (content.match(/[^\n]*\n|[^\n]+/g) ?? []).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
  const replacementStart = replacement.matchIndex;
  const replacementEnd = replacement.matchIndex + replacement.matchLength;
  let lower = 0;
  let upper = lines.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    const line = lines[middle];
    if (!line) {
      throw new Error("Replacement range is outside the base content.");
    }
    if (line.end <= replacementStart) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }
  const firstLine = lines[lower];
  const startLine = firstLine && replacementStart >= firstLine.start ? lower : -1;
  if (startLine === -1) {
    throw new Error("Replacement range is outside the base content.");
  }

  let endLine = startLine;
  while (endLine < lines.length) {
    const line = lines.at(endLine);
    if (!line || line.end >= replacementEnd) {
      break;
    }
    endLine++;
  }
  if (endLine >= lines.length) {
    throw new Error("Replacement range is outside the base content.");
  }
  return { startLine, endLine: endLine + 1 };
}

export function applyReplacements(content: string, replacements: TextReplacement[]): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const replacement of replacements) {
    const matchIndex = replacement.matchIndex;
    parts.push(content.slice(cursor, matchIndex), replacement.newText);
    cursor = matchIndex + replacement.matchLength;
  }
  parts.push(content.slice(cursor));
  return parts.join("");
}

type LineTerminator = "\r\n" | "\r" | "\n";

function getLineTerminator(line: string | undefined): LineTerminator | undefined {
  if (line === undefined) {
    return undefined;
  }
  if (line.endsWith("\r\n")) {
    return "\r\n";
  }
  if (line.endsWith("\n")) {
    return "\n";
  }
  return line.endsWith("\r") ? "\r" : undefined;
}

function restoreNormalizedLineEndings(
  normalizedContent: string,
  sourceLines: string[],
  fallback: LineTerminator,
): string {
  let sourceIndex = 0;
  return normalizedContent.replace(/\n/g, () => {
    const source = sourceLines[sourceIndex] ?? sourceLines.at(-1);
    sourceIndex++;
    return getLineTerminator(source) ?? fallback;
  });
}

function countLineBreaks(content: string): number {
  return content.match(/\n/g)?.length ?? 0;
}

export function applyReplacementsPreservingLineEndings(
  originalContent: string,
  baseContent: string,
  replacements: TextReplacement[],
): string {
  const originalLines = originalContent.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+/g) ?? [];
  const baseLines = getLineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
    throw new Error(
      "Cannot preserve original line endings because the base content has a different line count.",
    );
  }

  const fileFallback = detectLineEnding(originalContent);
  const originalOffsets = [0];
  for (const line of originalLines) {
    originalOffsets.push(originalOffsets.at(-1)! + line.length);
  }
  const restoredReplacements = replacements
    .toSorted((a, b) => a.matchIndex - b.matchIndex)
    .map((replacement) => {
      const { startLine, endLine } = getReplacementLineRange(baseLines, replacement);
      const matchEnd = replacement.matchIndex + replacement.matchLength;
      const restoredStart =
        originalOffsets[startLine]! + replacement.matchIndex - baseLines[startLine]!.start;
      // A consumed newline includes the whole original terminator, including CRLF's extra byte.
      const restoredEnd =
        matchEnd === baseLines[endLine - 1]!.end
          ? originalOffsets[endLine]!
          : originalOffsets[endLine - 1]! + matchEnd - baseLines[endLine - 1]!.start;
      const replacementSource = originalLines.slice(startLine, endLine);
      const replacementFallback =
        getLineTerminator(replacementSource[0]) ??
        getLineTerminator(originalLines[startLine - 1]) ??
        fileFallback;
      const consumedTerminatorCount = countLineBreaks(
        baseContent.slice(replacement.matchIndex, matchEnd),
      );
      const replacementTerminatorCount = countLineBreaks(replacement.newText);
      const terminatorSources = replacementSource.slice(0, Math.max(1, consumedTerminatorCount));
      const sourceOffset = Math.max(0, terminatorSources.length - replacementTerminatorCount);
      return {
        matchIndex: restoredStart,
        matchLength: restoredEnd - restoredStart,
        newText: restoreNormalizedLineEndings(
          replacement.newText,
          terminatorSources.slice(sourceOffset),
          replacementFallback,
        ),
      };
    });
  return applyReplacements(originalContent, restoredReplacements);
}

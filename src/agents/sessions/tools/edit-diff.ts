/** Pure file edit planning and shared display/unified-patch receipts. */

import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { levenshteinDistance } from "../../../shared/levenshtein-distance.js";
import { countNewlines, detectLineEnding, normalizeToLF } from "../../line-endings.js";
import { ToolInputError } from "../../tool-input-error.js";
import { prepareFileDiff, type FileDiff } from "./file-diff.js";

interface TextReplacement {
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

function findReplacementLine(lines: LineSpan[], offset: number, includeEnd: boolean): number {
  let lower = 0;
  let upper = lines.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    const line = lines[middle]!;
    if (line.end < offset || (!includeEnd && line.end === offset)) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }
  return lower;
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
  const startLine = findReplacementLine(lines, replacement.matchIndex, false);
  const endLine = findReplacementLine(
    lines,
    replacement.matchIndex + replacement.matchLength,
    true,
  );
  if (
    !lines[startLine] ||
    replacement.matchIndex < lines[startLine].start ||
    endLine >= lines.length
  ) {
    throw new Error("Replacement range is outside the base content.");
  }
  return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: TextReplacement[]): string {
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

function applyReplacementsPreservingLineEndings(
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
  const restoredReplacements = replacements.map((replacement) => {
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
    const consumedTerminatorCount = countNewlines(
      baseContent.slice(replacement.matchIndex, matchEnd),
    );
    const replacementTerminatorCount = countNewlines(replacement.newText);
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

interface FuzzyBoundary {
  /** Original offset when the normalized boundary begins a replacement. */
  readonly start?: number;
  /** Original offset when the normalized boundary ends a replacement. */
  readonly end?: number;
}

interface FuzzyNormalizedFile {
  text: string;
  boundaries: Array<FuzzyBoundary | undefined> | undefined;
}

const fuzzyGraphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

function foldFuzzyCharacters(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function normalizeForFuzzyMatch(text: string): string {
  return foldFuzzyCharacters(
    text
      .normalize("NFKC")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n"),
  );
}

function buildNfkcBoundaries(
  text: string,
  authoritativeNfkc: string,
): FuzzyNormalizedFile["boundaries"] | undefined {
  const boundaries: Array<FuzzyBoundary | undefined> = [];
  const normalizedSegments: string[] = [];
  let normalizedOffset = 0;

  for (const segment of fuzzyGraphemeSegmenter.segment(text)) {
    const sourceStart = segment.index;
    const sourceEnd = sourceStart + segment.segment.length;
    const normalizedSegment = segment.segment.normalize("NFKC");
    normalizedSegments.push(normalizedSegment);

    const boundary = boundaries[normalizedOffset] ?? {};
    if (normalizedSegment.length === 0) {
      // Preserve omitted source text on either side of this collapsed boundary.
      boundaries[normalizedOffset] = {
        end: boundary.end ?? sourceStart,
        start: sourceEnd,
      };
      continue;
    }

    boundaries[normalizedOffset] = {
      start: boundary.start ?? sourceStart,
      end: boundary.end ?? sourceStart,
    };
    normalizedOffset += normalizedSegment.length;
    boundaries[normalizedOffset] = { start: sourceEnd, end: sourceEnd };
  }

  // Grapheme segmentation is only a mapping aid. Whole-string NFKC remains
  // authoritative; fail closed if a runtime ever segments it differently.
  if (normalizedSegments.join("") !== authoritativeNfkc) {
    return undefined;
  }
  return boundaries;
}

function buildFuzzyBoundaries(
  text: string,
  normalizedText: string,
): FuzzyNormalizedFile["boundaries"] {
  const authoritativeNfkc = text.normalize("NFKC");
  const nfkcBoundaries = buildNfkcBoundaries(text, authoritativeNfkc);
  if (!nfkcBoundaries) {
    return undefined;
  }

  const boundaries: Array<FuzzyBoundary | undefined> = [];
  let sourceLineStart = 0;
  let normalizedLineStart = 0;

  while (sourceLineStart <= authoritativeNfkc.length) {
    const newlineIndex = authoritativeNfkc.indexOf("\n", sourceLineStart);
    const sourceLineEnd = newlineIndex === -1 ? authoritativeNfkc.length : newlineIndex;
    const line = authoritativeNfkc.slice(sourceLineStart, sourceLineEnd);
    const keptLineEnd = sourceLineStart + line.trimEnd().length;

    for (let offset = sourceLineStart; offset <= keptLineEnd; offset++) {
      const boundary = nfkcBoundaries[offset];
      if (boundary) {
        boundaries[normalizedLineStart + offset - sourceLineStart] = boundary;
      }
    }

    const normalizedLineEnd = normalizedLineStart + keptLineEnd - sourceLineStart;
    if (keptLineEnd < sourceLineEnd) {
      const beforeTrim = nfkcBoundaries[keptLineEnd];
      const afterTrim = nfkcBoundaries[sourceLineEnd];
      boundaries[normalizedLineEnd] = {
        end: beforeTrim?.end,
        start: afterTrim?.start,
      };
    }

    if (newlineIndex === -1) {
      break;
    }

    const afterNewline = nfkcBoundaries[sourceLineEnd + 1];
    boundaries[normalizedLineEnd + 1] = afterNewline;
    normalizedLineStart = normalizedLineEnd + 1;
    sourceLineStart = sourceLineEnd + 1;
  }

  if (boundaries.length > normalizedText.length + 1) {
    return undefined;
  }
  return boundaries;
}

export interface Edit {
  oldText: string;
  newText: string;
}

interface MatchedEdit extends TextReplacement {
  editIndex: number;
}

const EDIT_CANDIDATE_LIMIT = 3;
const EDIT_CANDIDATE_MAX_LINES = 1000;
const EDIT_CANDIDATE_MAX_SCAN_CHARS = 128 * 1024;
const EDIT_CANDIDATE_MAX_LINE_CHARS = 120;
const EDIT_CANDIDATE_MIN_SCORE = 0.45;

interface EditCandidate {
  lineNumber: number;
  line: string;
  score: number;
}

function getBoundedLines(text: string, maxLines: number, maxScanChars: number): string[] {
  return truncateUtf16Safe(text, maxScanChars)
    .split("\n", maxLines)
    .map((line) => truncateUtf16Safe(line, EDIT_CANDIDATE_MAX_LINE_CHARS));
}

function scoreCandidate(expected: string, candidate: string): number {
  const normalizedExpected = expected.trim();
  const normalizedCandidate = candidate.trim();
  const maxLength = Math.max(normalizedExpected.length, normalizedCandidate.length);
  if (maxLength === 0) {
    return 0;
  }

  // Length alone sets an upper bound on the possible similarity score.
  if (
    Math.min(normalizedExpected.length, normalizedCandidate.length) / maxLength <
    EDIT_CANDIDATE_MIN_SCORE
  ) {
    return 0;
  }

  return 1 - levenshteinDistance(normalizedExpected, normalizedCandidate) / maxLength;
}

function describeIndentation(line: string): string {
  const indentation = line.match(/^[ \t]*/)?.[0] ?? "";
  if (!indentation) {
    return "none";
  }
  const tabs = indentation.match(/\t/g)?.length ?? 0;
  const spaces = indentation.length - tabs;
  return tabs === 0 ? `${spaces} spaces` : `${spaces} spaces and ${tabs} tabs`;
}

function firstDifferenceIndex(left: string, right: string): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index++) {
    if (left.charAt(index) !== right.charAt(index)) {
      return index;
    }
  }
  return left.length === right.length ? -1 : sharedLength;
}

function describeCandidateDifference(expected: string, found: string): string {
  const expectedIndentation = expected.match(/^[ \t]*/)?.[0] ?? "";
  const foundIndentation = found.match(/^[ \t]*/)?.[0] ?? "";
  if (expectedIndentation !== foundIndentation) {
    return `indentation differs (expected ${describeIndentation(expected)}, found ${describeIndentation(found)})`;
  }

  const expectedBackslashes = expected.match(/\\/g)?.length ?? 0;
  const foundBackslashes = found.match(/\\/g)?.length ?? 0;
  if (expectedBackslashes !== foundBackslashes) {
    return `escaping differs (expected ${expectedBackslashes} backslashes, found ${foundBackslashes})`;
  }

  const differenceIndex = firstDifferenceIndex(expected, found);
  return differenceIndex === -1
    ? "this line matches; surrounding lines differ"
    : `first difference at column ${differenceIndex + 1}`;
}

function getCandidateHint(content: string, oldText: string): string {
  const expected = getBoundedLines(oldText, 32, 4096).reduce(
    (best, line) => (line.trim().length > best.trim().length ? line : best),
    "",
  );
  if (!expected.trim()) {
    return "";
  }
  const candidates = getBoundedLines(
    content,
    EDIT_CANDIDATE_MAX_LINES,
    EDIT_CANDIDATE_MAX_SCAN_CHARS,
  )
    .map((line, index): EditCandidate | undefined => {
      const score = scoreCandidate(expected, line);
      return score >= EDIT_CANDIDATE_MIN_SCORE ? { lineNumber: index + 1, line, score } : undefined;
    })
    .filter((candidate): candidate is EditCandidate => candidate !== undefined)
    .toSorted((left, right) => right.score - left.score || left.lineNumber - right.lineNumber)
    .slice(0, EDIT_CANDIDATE_LIMIT);
  if (candidates.length === 0) {
    return "";
  }
  const expectedDisplay = JSON.stringify(expected);
  return (
    "\nClosest matching lines:\n" +
    candidates
      .map((candidate) => {
        const foundDisplay = JSON.stringify(candidate.line);
        const differenceIndex = firstDifferenceIndex(expectedDisplay, foundDisplay);
        const markerIndex =
          differenceIndex === -1
            ? Math.min(expectedDisplay.length, foundDisplay.length)
            : differenceIndex;
        const markerWidth = Math.max(
          1,
          Math.min(12, Math.max(expectedDisplay.length, foundDisplay.length) - markerIndex),
        );
        return [
          `  near line ${candidate.lineNumber} (${Math.round(candidate.score * 100)}% match):`,
          `    expected: ${expectedDisplay}`,
          `    found:    ${foundDisplay}`,
          `              ${" ".repeat(markerIndex)}${"^".repeat(markerWidth)}`,
          `    hint: ${describeCandidateDifference(expected, candidate.line)}`,
        ].join("\n");
      })
      .join("\n")
  );
}

function getUnsafeFuzzyBoundaryError(path: string, editIndex: number, totalEdits: number): Error {
  const target = totalEdits === 1 ? "The fuzzy match" : `The fuzzy match for edits[${editIndex}]`;
  return new ToolInputError(
    `${target} in ${path} crosses an ambiguous Unicode-normalization or trimmed-whitespace boundary. Copy the exact source text or use a span whose normalized boundaries map cleanly.`,
  );
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * assembled from original spans so offsets remain stable. Fuzzy matching is
 * lookup-only: replacements always splice into the original content.
 */
function applyEdits(normalizedContent: string, edits: Edit[], path: string) {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  for (const [i, edit] of normalizedEdits.entries()) {
    if (edit.oldText.length === 0) {
      throw new ToolInputError(
        normalizedEdits.length === 1
          ? `oldText must not be empty in ${path}.`
          : `edits[${i}].oldText must not be empty in ${path}.`,
      );
    }
  }

  let fuzzyFile: FuzzyNormalizedFile | undefined;
  const matchedEdits: MatchedEdit[] = [];
  for (const [i, edit] of normalizedEdits.entries()) {
    let matchIndex = normalizedContent.indexOf(edit.oldText);
    let matchLength = edit.oldText.length;
    const fuzzy = matchIndex === -1;
    let searchContent = normalizedContent;
    let searchText = edit.oldText;
    if (fuzzy) {
      fuzzyFile ??= { text: normalizeForFuzzyMatch(normalizedContent), boundaries: undefined };
      searchContent = fuzzyFile.text;
      searchText = normalizeForFuzzyMatch(edit.oldText);
      matchIndex = searchContent.indexOf(searchText);
    }

    if (!searchText) {
      throw getUnsafeFuzzyBoundaryError(path, i, normalizedEdits.length);
    }
    let occurrences = 0;
    for (let at = matchIndex; at !== -1; at = searchContent.indexOf(searchText, at + 1)) {
      occurrences++;
    }
    if (occurrences > 1) {
      throw new ToolInputError(
        normalizedEdits.length === 1
          ? `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
          : `Found ${occurrences} occurrences of edits[${i}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
      );
    }
    if (matchIndex === -1) {
      const prefix =
        normalizedEdits.length === 1
          ? "Could not find the exact text"
          : `Could not find edits[${i}]`;
      const hint = getCandidateHint(normalizedContent, edit.oldText);
      throw new ToolInputError(
        `${prefix} in ${path}. The old text must match exactly including all whitespace and newlines.${hint}`,
      );
    }
    if (fuzzy && fuzzyFile) {
      // Uniqueness precedes boundary errors; only accepted fuzzy matches need the source map.
      fuzzyFile.boundaries ??= buildFuzzyBoundaries(normalizedContent, fuzzyFile.text);
      const start = fuzzyFile.boundaries?.[matchIndex]?.start;
      const end = fuzzyFile.boundaries?.[matchIndex + searchText.length]?.end;
      if (start === undefined || end === undefined) {
        throw getUnsafeFuzzyBoundaryError(path, i, normalizedEdits.length);
      }
      matchIndex = start;
      matchLength = end - start;
    }

    matchedEdits.push({
      editIndex: i,
      matchIndex,
      matchLength,
      newText: edit.newText,
    });
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1]!;
    const current = matchedEdits[i]!;
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new ToolInputError(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }

  return {
    newContent: applyReplacements(normalizedContent, matchedEdits),
    replacements: matchedEdits,
  };
}

type FileEditPlan =
  | { changed: false; message: string }
  | { changed: true; content: string; editCount: number; receipt: FileDiff };

export function prepareFileEdit(content: string, edits: Edit[], path: string): FileEditPlan {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = content.slice(bom.length);
  const normalized = normalizeToLF(text);
  const noOpEdits: Edit[] = [];
  const realEdits: Edit[] = [];
  for (const edit of edits) {
    if (edit.oldText === edit.newText) {
      applyEdits(normalized, [edit], path);
      noOpEdits.push(edit);
    } else {
      realEdits.push(edit);
    }
  }
  if (noOpEdits.length > 0) {
    applyEdits(normalized, noOpEdits, path);
  }
  const exactNoOpEdits = noOpEdits.filter((edit) =>
    normalized.includes(normalizeToLF(edit.oldText)),
  );
  if (exactNoOpEdits.length > 0 && realEdits.length > 0) {
    applyEdits(normalized, [...exactNoOpEdits, ...realEdits], path);
  }
  if (realEdits.length === 0) {
    return {
      changed: false,
      message: `No changes made to ${path}. The replacement text is identical to the original.`,
    };
  }
  const { newContent, replacements } = applyEdits(normalized, realEdits, path);
  if (normalized === newContent) {
    return {
      changed: false,
      message: `No changes made to ${path}. The replacement produced identical content.`,
    };
  }
  const finalContent = applyReplacementsPreservingLineEndings(text, normalized, replacements);
  if (normalizeToLF(finalContent) !== newContent) {
    throw new Error("Line-ending restoration changed the normalized edit result.");
  }
  const receipt = prepareFileDiff(path, normalized, newContent);
  if (!receipt) {
    throw new Error("Unbounded edit diff did not produce a patch");
  }
  return { changed: true, content: bom + finalContent, editCount: realEdits.length, receipt };
}

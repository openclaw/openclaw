/** Pure file edit planning and shared display/unified-patch receipts. */

import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { levenshteinDistance } from "../../../shared/levenshtein-distance.js";
import { normalizeToLF } from "../../line-endings.js";
import {
  applyReplacements,
  applyReplacementsPreservingLineEndings,
  type TextReplacement,
} from "./edit-replacements.js";
import { prepareFileDiff, type FileDiff } from "./file-diff.js";

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

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 *
 */
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

function translateFuzzySpan(
  normalized: FuzzyNormalizedFile,
  fuzzyStart: number,
  fuzzyLength: number,
): { originalStart: number; originalLength: number } | undefined {
  const fuzzyEnd = fuzzyStart + fuzzyLength;
  const originalStart = normalized.boundaries?.[fuzzyStart]?.start;
  const originalEnd = normalized.boundaries?.[fuzzyEnd]?.end;
  if (originalStart === undefined || originalEnd === undefined) {
    return undefined;
  }
  return {
    originalStart,
    originalLength: originalEnd - originalStart,
  };
}

interface FuzzyMatchResult {
  /** Whether a match was found */
  found: boolean;
  /** The index where the match starts (in original-content coordinates) */
  index: number;
  /** Length of the matched text (in original-content coordinates) */
  matchLength: number;
  /** Whether fuzzy matching was used (false = exact match) */
  usedFuzzyMatch: boolean;
  /** The normalized match exists but cannot map to an unambiguous source span. */
  unsafeBoundary?: boolean;
}

export interface Edit {
  oldText: string;
  newText: string;
}

class EditNoChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditNoChangeError";
  }
}

interface MatchedEdit extends TextReplacement {
  editIndex: number;
}

interface AppliedEdits {
  baseContent: string;
  newContent: string;
  replacements: MatchedEdit[];
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * When fuzzy matching is used and an offsetMap is provided, the returned
 * index and matchLength are translated back to original-content coordinates
 * so the caller can apply replacements against the un-normalized content.
 */
function fuzzyFindText(
  content: string,
  oldText: string,
  normalizedFile?: FuzzyNormalizedFile,
): FuzzyMatchResult {
  // Try exact match first
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
    };
  }

  // Try fuzzy match - work entirely in normalized space
  const fuzzyContent = normalizedFile?.text ?? normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  if (!fuzzyOldText) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: true,
      unsafeBoundary: true,
    };
  }
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

  if (fuzzyIndex === -1) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
    };
  }

  // Source boundaries matter only after normalized text actually matches.
  if (normalizedFile && !normalizedFile.boundaries) {
    normalizedFile.boundaries = buildFuzzyBoundaries(content, normalizedFile.text);
  }
  const translated = normalizedFile
    ? translateFuzzySpan(normalizedFile, fuzzyIndex, fuzzyOldText.length)
    : undefined;
  if (!translated) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: true,
      unsafeBoundary: true,
    };
  }

  return {
    found: true,
    index: translated.originalStart,
    matchLength: translated.originalLength,
    usedFuzzyMatch: true,
  };
}

/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

function countOccurrences(fuzzyContent: string, oldText: string): number {
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  if (!fuzzyOldText) {
    return 0;
  }
  return fuzzyContent.split(fuzzyOldText).length - 1;
}

function countExactOccurrences(content: string, oldText: string): number {
  return content.split(oldText).length - 1;
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

function getNotFoundError(
  path: string,
  editIndex: number,
  totalEdits: number,
  content: string,
  oldText: string,
): Error {
  const prefix =
    totalEdits === 1 ? "Could not find the exact text" : `Could not find edits[${editIndex}]`;
  const hint = getCandidateHint(content, oldText);
  return new Error(
    `${prefix} in ${path}. The old text must match exactly including all whitespace and newlines.${hint}`,
  );
}

function getDuplicateError(
  path: string,
  editIndex: number,
  totalEdits: number,
  occurrences: number,
): Error {
  if (totalEdits === 1) {
    return new Error(
      `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
    );
  }
  return new Error(
    `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
  );
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(`oldText must not be empty in ${path}.`);
  }
  return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): EditNoChangeError {
  if (totalEdits === 1) {
    return new EditNoChangeError(
      `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
    );
  }
  return new EditNoChangeError(
    `No changes made to ${path}. The replacements produced identical content.`,
  );
}

function getUnsafeFuzzyBoundaryError(path: string, editIndex: number, totalEdits: number): Error {
  const target = totalEdits === 1 ? "The fuzzy match" : `The fuzzy match for edits[${editIndex}]`;
  return new Error(
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
function applyEdits(normalizedContent: string, edits: Edit[], path: string): AppliedEdits {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  for (const [i, edit] of normalizedEdits.entries()) {
    if (edit.oldText.length === 0) {
      throw getEmptyOldTextError(path, i, normalizedEdits.length);
    }
  }

  const needsFuzzyMapping = normalizedEdits.some(
    (edit) => !normalizedContent.includes(edit.oldText),
  );
  const fuzzyFile: FuzzyNormalizedFile | undefined = needsFuzzyMapping
    ? { text: normalizeForFuzzyMatch(normalizedContent), boundaries: undefined }
    : undefined;
  const matchedEdits: MatchedEdit[] = [];
  for (const [i, edit] of normalizedEdits.entries()) {
    const matchResult = fuzzyFindText(normalizedContent, edit.oldText, fuzzyFile);
    const occurrences =
      fuzzyFile && matchResult.usedFuzzyMatch
        ? countOccurrences(fuzzyFile.text, edit.oldText)
        : countExactOccurrences(normalizedContent, edit.oldText);
    if (occurrences > 1) {
      throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
    }
    if (matchResult.unsafeBoundary) {
      throw getUnsafeFuzzyBoundaryError(path, i, normalizedEdits.length);
    }
    if (!matchResult.found) {
      throw getNotFoundError(path, i, normalizedEdits.length, normalizedContent, edit.oldText);
    }

    matchedEdits.push({
      editIndex: i,
      matchIndex: matchResult.index,
      matchLength: matchResult.matchLength,
      newText: edit.newText,
    });
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits.at(i - 1);
    const current = matchedEdits.at(i);
    if (!previous || !current) {
      continue;
    }
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }

  const newContent = applyReplacements(normalizedContent, matchedEdits);

  if (normalizedContent === newContent) {
    throw getNoChangeError(path, normalizedEdits.length);
  }

  return {
    baseContent: normalizedContent,
    newContent,
    replacements: matchedEdits,
  };
}

function applyEditsPreservingLineEndings(
  originalContent: string,
  edits: Edit[],
  path: string,
): { baseContent: string; newContent: string; finalContent: string } {
  const applied = applyEdits(normalizeToLF(originalContent), edits, path);
  const finalContent = applyReplacementsPreservingLineEndings(
    originalContent,
    applied.baseContent,
    applied.replacements,
  );
  if (normalizeToLF(finalContent) !== applied.newContent) {
    throw new Error("Line-ending restoration changed the normalized edit result.");
  }
  return {
    baseContent: applied.baseContent,
    newContent: applied.newContent,
    finalContent,
  };
}

export interface EditDiffResult {
  diff: string;
  firstChangedLine: number | undefined;
}

export interface EditDiffError {
  error: string;
}

function validateNoOpEditTargets(
  normalizedContent: string,
  noOpEdits: Edit[],
  realEdits: Edit[],
  path: string,
): void {
  if (noOpEdits.length > 0) {
    applyEdits(
      normalizedContent,
      noOpEdits.map((edit) => ({ oldText: edit.oldText, newText: "" })),
      path,
    );
  }
  const exactNoOpEdits = noOpEdits.filter((edit) =>
    normalizedContent.includes(normalizeToLF(edit.oldText)),
  );
  if (exactNoOpEdits.length > 0 && realEdits.length > 0) {
    applyEdits(
      normalizedContent,
      [...exactNoOpEdits, ...realEdits].map((edit) => ({
        oldText: edit.oldText,
        newText: "",
      })),
      path,
    );
  }
}

function splitNoOpEdits(
  normalizedContent: string,
  edits: Edit[],
  path: string,
): { noOpEdits: Edit[]; realEdits: Edit[] } {
  const noOpEdits: Edit[] = [];
  const realEdits: Edit[] = [];
  for (const edit of edits) {
    if (edit.oldText === edit.newText) {
      applyEdits(normalizedContent, [{ oldText: edit.oldText, newText: "" }], path);
      noOpEdits.push(edit);
    } else {
      realEdits.push(edit);
    }
  }
  return { noOpEdits, realEdits };
}

export type FileEditPlan =
  | { changed: false; message: string }
  | { changed: true; content: string; editCount: number; receipt: FileDiff };

export function prepareFileEdit(content: string, edits: Edit[], path: string): FileEditPlan {
  try {
    const { bom, text } = stripBom(content);
    const normalized = normalizeToLF(text);
    const { noOpEdits, realEdits } = splitNoOpEdits(normalized, edits, path);
    validateNoOpEditTargets(normalized, noOpEdits, realEdits, path);
    if (realEdits.length === 0) {
      return {
        changed: false,
        message: `No changes made to ${path}. The replacement text is identical to the original.`,
      };
    }
    const { baseContent, newContent, finalContent } = applyEditsPreservingLineEndings(
      text,
      realEdits,
      path,
    );
    const receipt = prepareFileDiff(path, baseContent, newContent);
    if (!receipt) {
      throw new Error("Unbounded edit diff did not produce a patch");
    }
    return { changed: true, content: bom + finalContent, editCount: realEdits.length, receipt };
  } catch (error) {
    // Worker failures erase Error subclasses; no-change is a successful planning outcome.
    if (error instanceof EditNoChangeError) {
      return {
        changed: false,
        message: `No changes made to ${path}. The replacement produced identical content.`,
      };
    }
    throw error;
  }
}

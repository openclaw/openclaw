import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { readWorkspaceText } from "./memory-workspace-files.js";
import { resolveShortTermSourcePathCandidates } from "./short-term-promotion-record.js";
import type { PromotionCandidate } from "./short-term-promotion-types.js";
import {
  isGenericDailyHeading,
  normalizeSnippet,
  SHORT_TERM_BASENAME_RE,
} from "./short-term-promotion-utils.js";

const PROMOTION_LIST_MARKER_RE = /^(?:\d+\.\s+|[-*+]\s+)/;
const MANAGED_DREAMING_HEADINGS = new Set(["light sleep", "rem sleep"]);
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

// The stored snippet and the live range must pass through the same
// normalization before comparison. Notes routinely gain HTML comments after a
// candidate is recorded; leaving those comments in only the live copy breaks
// exact containment and degrades the match to a fragment anchor.
function normalizeRecallSnippet(raw: string): string {
  return normalizeSnippet(raw.replace(HTML_COMMENT_RE, " "));
}

function normalizeRangeSnippet(lines: string[], startLine: number, endLine: number): string {
  const startIndex = Math.max(0, startLine - 1);
  const endIndex = Math.min(lines.length, endLine);
  if (startIndex >= endIndex) {
    return "";
  }
  return normalizeRecallSnippet(lines.slice(startIndex, endIndex).join(" "));
}

function normalizeListMarkerFreeRangeSnippet(
  lines: string[],
  startLine: number,
  endLine: number,
): string {
  const startIndex = Math.max(0, startLine - 1);
  const endIndex = Math.min(lines.length, endLine);
  if (startIndex >= endIndex) {
    return "";
  }
  const strippedLines = lines.slice(startIndex, endIndex).map((line) => {
    const trimmed = line.trim();
    const withoutMarker = trimmed.replace(PROMOTION_LIST_MARKER_RE, "");
    return { text: withoutMarker, hadListMarker: withoutMarker !== trimmed };
  });
  const joiner =
    strippedLines.length > 1 && strippedLines.every((line) => line.hadListMarker) ? "; " : " ";
  return normalizeRecallSnippet(strippedLines.map((line) => line.text).join(joiner));
}

function normalizeDailyHeadingForPromotion(line: string): string | null {
  const match = line.trim().match(/^#{1,6}\s+(.+)$/);
  const heading = match?.[1]?.replace(PROMOTION_LIST_MARKER_RE, "").trim() ?? "";
  const normalized = normalizeSnippet(heading);
  if (
    !normalized ||
    SHORT_TERM_BASENAME_RE.test(normalized) ||
    MANAGED_DREAMING_HEADINGS.has(normalized.toLowerCase()) ||
    isGenericDailyHeading(normalized)
  ) {
    return null;
  }
  return normalized;
}

function buildRelocatedDailyHeadingLookup(lines: string[]): (string | null)[] {
  const headings: (string | null)[] = Array.from({ length: lines.length + 1 }, () => null);
  let currentHeading: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    headings[index + 1] = currentHeading;
    const line = lines[index] ?? "";
    if (DREAMING_FENCE_START_RE.test(line) || DREAMING_FENCE_END_RE.test(line)) {
      currentHeading = null;
      continue;
    }
    if (/^#{1,6}\s+.+$/.test(line.trim())) {
      currentHeading = normalizeDailyHeadingForPromotion(line);
    }
  }
  return headings;
}

function buildListMarkerFreeMatchSnippet(
  heading: string | null,
  listMarkerFreeSnippet: string,
): string {
  if (!listMarkerFreeSnippet) {
    return listMarkerFreeSnippet;
  }
  return heading ? normalizeSnippet(`${heading}: ${listMarkerFreeSnippet}`) : listMarkerFreeSnippet;
}

function targetSnippetHasHeadingContext(targetSnippet: string, bodySnippet: string): boolean {
  if (!targetSnippet || !bodySnippet || targetSnippet === bodySnippet) {
    return false;
  }
  const bodyIndex = targetSnippet.indexOf(bodySnippet);
  if (bodyIndex <= 0) {
    return false;
  }
  return sliceUtf16Safe(targetSnippet, 0, bodyIndex).trimEnd().endsWith(":");
}

function extractTargetHeadingBodySnippet(
  targetSnippet: string,
  bodySnippet: string,
): string | null {
  if (!targetSnippet || !bodySnippet || targetSnippet === bodySnippet) {
    return null;
  }
  if (bodySnippet.startsWith(targetSnippet)) {
    return null;
  }
  const normalizedBody = normalizeSnippet(bodySnippet);
  for (let separatorIndex = targetSnippet.indexOf(": "); separatorIndex > 0;) {
    const targetBody = normalizeSnippet(targetSnippet.slice(separatorIndex + 2));
    if (targetBody && normalizedBody.startsWith(targetBody)) {
      return targetBody;
    }
    separatorIndex = targetSnippet.indexOf(": ", separatorIndex + 2);
  }
  return null;
}

function compareCandidateWindow(targetSnippet: string, windowSnippet: string): number {
  if (!targetSnippet || !windowSnippet) {
    return 0;
  }
  if (windowSnippet === targetSnippet) {
    return 3;
  }
  if (windowSnippet.includes(targetSnippet)) {
    return 2;
  }
  if (targetSnippet.includes(windowSnippet)) {
    return 1;
  }
  return 0;
}

function relocateCandidateRange(
  lines: string[],
  candidate: PromotionCandidate,
  managedFencePrefix: Int32Array,
): { startLine: number; endLine: number; snippet: string } | null {
  const targetSnippet = normalizeRecallSnippet(candidate.snippet);
  const preferredSpan = Math.max(1, candidate.endLine - candidate.startLine + 1);
  if (targetSnippet.length === 0) {
    // normalizeRecallSnippet strips HTML comments, so a stored anchor that was
    // entirely a comment (recording accepts it) normalizes away to nothing.
    // Its recorded coordinates then point at whatever text now occupies those
    // lines; trusting them would promote unrelated content. An anchor that was
    // empty at recording time is the only shape that may use positional
    // fallback, because it never claimed to match live text.
    if (normalizeSnippet(candidate.snippet).length > 0) {
      return null;
    }
    const fallbackSnippet = normalizeRangeSnippet(lines, candidate.startLine, candidate.endLine);
    if (!fallbackSnippet) {
      return null;
    }
    // Recorded coordinates are also managed-range trust: a comment-only anchor
    // whose lines now sit inside a dreaming fence would promote scratchwork.
    if (
      lineRangeOverlapsDreamingFence(managedFencePrefix, candidate.startLine, candidate.endLine)
    ) {
      return null;
    }
    return {
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      snippet: fallbackSnippet,
    };
  }

  const exactSnippet = normalizeRangeSnippet(lines, candidate.startLine, candidate.endLine);
  if (
    exactSnippet === targetSnippet &&
    !lineRangeOverlapsDreamingFence(managedFencePrefix, candidate.startLine, candidate.endLine)
  ) {
    return {
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      snippet: exactSnippet,
    };
  }

  const maxSpan = Math.min(lines.length, Math.max(preferredSpan + 3, 8));
  const headingLookup = buildRelocatedDailyHeadingLookup(lines);
  let bestMatch:
    | { startLine: number; endLine: number; snippet: string; quality: number; distance: number }
    | undefined;
  for (let startIndex = 0; startIndex < lines.length; startIndex += 1) {
    for (let span = 1; span <= maxSpan && startIndex + span <= lines.length; span += 1) {
      const startLine = startIndex + 1;
      const endLine = startIndex + span;
      // Managed windows are ineligible for selection. Comment stripping can
      // turn a marker-bearing window into an exact match that outranks the
      // eligible text beside the fence, and the apply-time fence guard would
      // then discard that winner, silently dropping a candidate whose text is
      // still available just outside the fence.
      if (lineRangeOverlapsDreamingFence(managedFencePrefix, startLine, endLine)) {
        continue;
      }
      const snippet = normalizeRangeSnippet(lines, startLine, endLine);
      const comparison = compareCandidateWindow(targetSnippet, snippet);
      const listMarkerFreeSnippet = normalizeListMarkerFreeRangeSnippet(lines, startLine, endLine);
      const listMarkerFreeMatchSnippet = buildListMarkerFreeMatchSnippet(
        headingLookup[startLine] ?? null,
        listMarkerFreeSnippet,
      );
      const listMarkerFreeComparison =
        listMarkerFreeSnippet === snippet
          ? 0
          : compareCandidateWindow(targetSnippet, listMarkerFreeSnippet);
      const listMarkerFreeContextComparison =
        listMarkerFreeMatchSnippet === listMarkerFreeSnippet
          ? 0
          : compareCandidateWindow(targetSnippet, listMarkerFreeMatchSnippet);
      const targetHeadingBodySnippet = extractTargetHeadingBodySnippet(
        targetSnippet,
        listMarkerFreeSnippet,
      );
      const targetHeadingBodyComparison =
        targetHeadingBodySnippet && listMarkerFreeMatchSnippet !== listMarkerFreeSnippet
          ? compareCandidateWindow(targetHeadingBodySnippet, listMarkerFreeSnippet)
          : 0;
      const useTargetHeadingBodyContext =
        targetHeadingBodyComparison > 0 &&
        targetHeadingBodyComparison >= comparison &&
        targetHeadingBodyComparison >= listMarkerFreeComparison;
      const useListMarkerFreeContext =
        !useTargetHeadingBodyContext &&
        listMarkerFreeContextComparison > comparison &&
        listMarkerFreeContextComparison >= listMarkerFreeComparison;
      const useListMarkerFree = !useListMarkerFreeContext && listMarkerFreeComparison > comparison;
      const bestComparison = useTargetHeadingBodyContext
        ? targetHeadingBodyComparison
        : useListMarkerFreeContext
          ? listMarkerFreeContextComparison
          : useListMarkerFree
            ? listMarkerFreeComparison
            : comparison;
      if (bestComparison === 0) {
        continue;
      }
      const matchedSnippet =
        useTargetHeadingBodyContext || useListMarkerFreeContext
          ? listMarkerFreeMatchSnippet
          : useListMarkerFree
            ? targetSnippetHasHeadingContext(targetSnippet, listMarkerFreeSnippet)
              ? listMarkerFreeMatchSnippet
              : listMarkerFreeSnippet
            : snippet;
      const distance = Math.abs(startLine - candidate.startLine);
      if (
        !bestMatch ||
        bestComparison > bestMatch.quality ||
        (bestComparison === bestMatch.quality && distance < bestMatch.distance) ||
        (bestComparison === bestMatch.quality &&
          distance === bestMatch.distance &&
          Math.abs(span - preferredSpan) <
            Math.abs(bestMatch.endLine - bestMatch.startLine + 1 - preferredSpan))
      ) {
        bestMatch = {
          startLine,
          endLine,
          snippet: matchedSnippet,
          quality: bestComparison,
          distance,
        };
      }
    }
  }

  if (!bestMatch || bestMatch.quality === 1) {
    // Quality 1 means the window is only a fragment of the recorded snippet.
    // Anchoring on it would silently promote the wrong lines of the right
    // file, so the candidate is reported as lost instead.
    return null;
  }
  return {
    startLine: bestMatch.startLine,
    endLine: bestMatch.endLine,
    snippet: bestMatch.snippet,
  };
}

const DREAMING_FENCE_START_RE = /<!--\s*openclaw:dreaming:[a-z][a-z0-9-]*:start\s*-->/i;
const DREAMING_FENCE_END_RE = /<!--\s*openclaw:dreaming:[a-z][a-z0-9-]*:end\s*-->/i;

// One forward pass folds managed dreaming membership into prefix sums: a line
// counts when it carries a dreaming marker or sits inside an open dreaming
// fence. Relocation compares every candidate window against the note, so
// eligibility checks must be O(1) per window; rescanning from the top for each
// window turns a moved or unresolved passage in a large fence-free note into
// quadratic synchronous work.
function buildDreamingFenceManagedPrefix(lines: string[]): Int32Array {
  const managedPrefix = new Int32Array(lines.length + 1);
  let insideFence = false;
  let managedSoFar = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const isStart = DREAMING_FENCE_START_RE.test(line);
    const isEnd = DREAMING_FENCE_END_RE.test(line);
    if (isStart || isEnd) {
      // The marker line itself is managed-block content. A relocated range
      // that includes a `<!-- openclaw:dreaming:*:start/end -->` marker would
      // build its snippet from raw lines that contain that marker text and
      // leak it into MEMORY.md alongside any adjacent fenced content captured
      // by the same window.
      insideFence = isStart;
      managedSoFar += 1;
    } else if (insideFence) {
      managedSoFar += 1;
    }
    managedPrefix[index + 1] = managedSoFar;
  }
  return managedPrefix;
}

function lineRangeOverlapsDreamingFence(
  managedPrefix: Int32Array,
  startLine: number,
  endLine: number,
): boolean {
  const lineCount = managedPrefix.length - 1;
  if (lineCount === 0) {
    return false;
  }
  const safeStart = Math.max(1, Math.min(startLine, lineCount));
  const safeEnd = Math.max(safeStart, Math.min(endLine, lineCount));
  return (managedPrefix[safeEnd] ?? 0) - (managedPrefix[safeStart - 1] ?? 0) > 0;
}

export async function rehydratePromotionCandidate(
  workspaceDir: string,
  candidate: PromotionCandidate,
): Promise<PromotionCandidate | null> {
  const sourcePaths = resolveShortTermSourcePathCandidates(workspaceDir, candidate.path);
  for (const sourcePath of sourcePaths) {
    let rawSource: string;
    try {
      rawSource = await readWorkspaceText(workspaceDir, sourcePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        continue;
      }
      throw err;
    }

    const lines = rawSource.split(/\r?\n/);
    const managedFencePrefix = buildDreamingFenceManagedPrefix(lines);
    const relocated = relocateCandidateRange(lines, candidate, managedFencePrefix);
    if (!relocated) {
      continue;
    }
    // Managed dreaming blocks in daily memory files are scratchwork, not durable
    // content. If rehydration lands inside an openclaw:dreaming fence (for example
    // because file edits shifted lines between ranking and apply), refuse the
    // candidate so dream artifacts cannot be promoted into MEMORY.md.
    if (
      lineRangeOverlapsDreamingFence(managedFencePrefix, relocated.startLine, relocated.endLine)
    ) {
      continue;
    }
    return {
      ...candidate,
      startLine: relocated.startLine,
      endLine: relocated.endLine,
      snippet: relocated.snippet,
    };
  }
  return null;
}

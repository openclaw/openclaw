import fs from "node:fs/promises";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveShortTermSourcePathCandidates } from "./short-term-promotion-record.js";
import type { PromotionCandidate } from "./short-term-promotion-types.js";
import { normalizeSnippet, SHORT_TERM_BASENAME_RE } from "./short-term-promotion-utils.js";

const GENERIC_DAY_HEADING_RE =
  /^(?:(?:mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)(?:,\s+)?)?(?:(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}[/-]\d{2}[/-]\d{2})$/i;
const PROMOTION_LIST_MARKER_RE = /^(?:\d+\.\s+|[-*+]\s+)/;
const MANAGED_DREAMING_HEADINGS = new Set(["light sleep", "rem sleep"]);

function normalizeRangeSnippet(lines: string[], startLine: number, endLine: number): string {
  const startIndex = Math.max(0, startLine - 1);
  const endIndex = Math.min(lines.length, endLine);
  if (startIndex >= endIndex) {
    return "";
  }
  return normalizeSnippet(lines.slice(startIndex, endIndex).join(" "));
}

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/gu;

/**
 * Comparison-only normalization. Comments are invisible to a reader and any tool
 * can add or remove one between recording and rehydration, so they must not decide
 * whether a stored range still matches the lines it was recorded from.
 */
function normalizeComparableSnippet(raw: string): string {
  return normalizeSnippet(raw.replace(HTML_COMMENT_RE, " "));
}

function lineRangesOverlap(
  left: { startLine: number; endLine: number },
  right: { startLine: number; endLine: number },
): boolean {
  return left.startLine <= right.endLine && right.startLine <= left.endLine;
}

/** Returns the index of the tracked group farthest from the stored range. */
function findFarthestGroupIndex(groups: Array<{ distance: number }>): number {
  let farthestIndex = 0;
  for (let index = 1; index < groups.length; index += 1) {
    const group = groups[index];
    const farthest = groups[farthestIndex];
    if (group && farthest && group.distance > farthest.distance) {
      farthestIndex = index;
    }
  }
  return farthestIndex;
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
  return normalizeSnippet(strippedLines.map((line) => line.text).join(joiner));
}

function normalizeDailyHeadingForPromotion(line: string): string | null {
  const match = line.trim().match(/^#{1,6}\s+(.+)$/);
  const heading = match?.[1]?.replace(PROMOTION_LIST_MARKER_RE, "").trim() ?? "";
  const normalized = normalizeSnippet(heading);
  if (
    !normalized ||
    SHORT_TERM_BASENAME_RE.test(normalized) ||
    isGenericDailyHeadingForPromotion(normalized)
  ) {
    return null;
  }
  return normalized;
}

function isGenericDailyHeadingForPromotion(heading: string): boolean {
  const normalized = heading.trim().replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();
  if (MANAGED_DREAMING_HEADINGS.has(lower)) {
    return true;
  }
  if (lower === "today" || lower === "yesterday" || lower === "tomorrow") {
    return true;
  }
  if (lower === "morning" || lower === "afternoon" || lower === "evening" || lower === "night") {
    return true;
  }
  return GENERIC_DAY_HEADING_RE.test(normalized);
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

function compareCandidateWindow(
  targetSnippet: string,
  windowSnippet: string,
): { matched: boolean; quality: number } {
  if (!targetSnippet || !windowSnippet) {
    return { matched: false, quality: 0 };
  }
  if (windowSnippet === targetSnippet) {
    return { matched: true, quality: 3 };
  }
  if (windowSnippet.includes(targetSnippet)) {
    return { matched: true, quality: 2 };
  }
  if (targetSnippet.includes(windowSnippet)) {
    return { matched: true, quality: 1 };
  }
  return { matched: false, quality: 0 };
}

function relocateCandidateRange(
  lines: string[],
  candidate: PromotionCandidate,
): { startLine: number; endLine: number; snippet: string } | null {
  const targetSnippet = normalizeSnippet(candidate.snippet);
  const comparableTarget = normalizeComparableSnippet(candidate.snippet);
  const comparisonTarget = comparableTarget || targetSnippet;
  const toComparable = (snippet: string): string =>
    comparableTarget ? normalizeComparableSnippet(snippet) : snippet;
  const preferredSpan = Math.max(1, candidate.endLine - candidate.startLine + 1);
  if (targetSnippet.length === 0) {
    const fallbackSnippet = normalizeRangeSnippet(lines, candidate.startLine, candidate.endLine);
    if (!fallbackSnippet) {
      return null;
    }
    return {
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      snippet: fallbackSnippet,
    };
  }

  const exactSnippet = normalizeRangeSnippet(lines, candidate.startLine, candidate.endLine);
  const storedRangeIsManaged = lineRangeOverlapsDreamingFence(
    lines,
    candidate.startLine,
    candidate.endLine,
  );
  if (
    !storedRangeIsManaged &&
    (exactSnippet === targetSnippet || toComparable(exactSnippet) === comparisonTarget)
  ) {
    return {
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      snippet: exactSnippet,
    };
  }

  const maxSpan = Math.min(lines.length, Math.max(preferredSpan + 3, 8));
  const headingLookup = buildRelocatedDailyHeadingLookup(lines);
  // Managed dreaming windows are resolved once for the whole scan: a window made of the
  // markers must not win selection, or the post-relocation fence guard would reject the
  // candidate instead of the eligible window next to it (#151173 review).
  const managedFenceLines = resolveManagedFenceLines(lines);
  const overlapsManagedFence = (startLine: number, endLine: number): boolean => {
    for (let line = startLine; line <= endLine; line += 1) {
      if (managedFenceLines[line - 1]) {
        return true;
      }
    }
    return false;
  };
  let bestMatch:
    | {
        startLine: number;
        endLine: number;
        snippet: string;
        quality: number;
        distance: number;
        reconstruction: boolean;
      }
    | undefined;
  // Top-quality matches kept for the unresolved-tie check below; bounded because a
  // repetitive note can match in many places.
  const MAX_TRACKED_MATCHES = 16;
  let topQuality = 0;
  // One entry per distinct place, not per window: blank lines make several windows of the
  // same occurrence normalize identically, and a window cap would then drop an equally
  // close second place before the tie check sees it.
  let topGroups: Array<{ startLine: number; endLine: number; distance: number }> = [];
  for (let startIndex = 0; startIndex < lines.length; startIndex += 1) {
    for (let span = 1; span <= maxSpan && startIndex + span <= lines.length; span += 1) {
      const startLine = startIndex + 1;
      const endLine = startIndex + span;
      if (overlapsManagedFence(startLine, endLine)) {
        continue;
      }
      const snippet = normalizeRangeSnippet(lines, startLine, endLine);
      const comparison = compareCandidateWindow(comparisonTarget, toComparable(snippet));
      const listMarkerFreeSnippet = normalizeListMarkerFreeRangeSnippet(lines, startLine, endLine);
      const listMarkerFreeMatchSnippet = buildListMarkerFreeMatchSnippet(
        headingLookup[startLine] ?? null,
        listMarkerFreeSnippet,
      );
      const listMarkerFreeComparison =
        listMarkerFreeSnippet === snippet
          ? { matched: false, quality: 0 }
          : compareCandidateWindow(comparisonTarget, toComparable(listMarkerFreeSnippet));
      const listMarkerFreeContextComparison =
        listMarkerFreeMatchSnippet === listMarkerFreeSnippet
          ? { matched: false, quality: 0 }
          : compareCandidateWindow(comparisonTarget, toComparable(listMarkerFreeMatchSnippet));
      const targetHeadingBodySnippet = extractTargetHeadingBodySnippet(
        targetSnippet,
        listMarkerFreeSnippet,
      );
      const targetHeadingBodyComparison =
        targetHeadingBodySnippet && listMarkerFreeMatchSnippet !== listMarkerFreeSnippet
          ? compareCandidateWindow(
              normalizeComparableSnippet(targetHeadingBodySnippet),
              toComparable(listMarkerFreeSnippet),
            )
          : { matched: false, quality: 0 };
      const useTargetHeadingBodyContext =
        targetHeadingBodyComparison.matched &&
        targetHeadingBodyComparison.quality >= comparison.quality &&
        targetHeadingBodyComparison.quality >= listMarkerFreeComparison.quality;
      const useListMarkerFreeContext =
        !useTargetHeadingBodyContext &&
        listMarkerFreeContextComparison.quality > comparison.quality &&
        listMarkerFreeContextComparison.quality >= listMarkerFreeComparison.quality;
      const useListMarkerFree =
        !useListMarkerFreeContext && listMarkerFreeComparison.quality > comparison.quality;
      const bestComparison = useTargetHeadingBodyContext
        ? targetHeadingBodyComparison
        : useListMarkerFreeContext
          ? listMarkerFreeContextComparison
          : useListMarkerFree
            ? listMarkerFreeComparison
            : comparison;
      if (!bestComparison.matched) {
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
      const matchRange = { startLine, endLine };
      const reconstructionUsed =
        useTargetHeadingBodyContext || useListMarkerFreeContext || useListMarkerFree;
      if (bestComparison.quality > topQuality) {
        topQuality = bestComparison.quality;
        topGroups = [];
      }
      if (bestComparison.quality === topQuality) {
        const groupIndex = topGroups.findIndex((group) => lineRangesOverlap(group, matchRange));
        const group = groupIndex >= 0 ? topGroups[groupIndex] : undefined;
        if (group) {
          topGroups[groupIndex] = {
            startLine: Math.min(group.startLine, startLine),
            endLine: Math.max(group.endLine, endLine),
            // Group distance matches bestMatch's window distance semantics, so the
            // ambiguity check compares the same notion selection does (#151299 Rev 3).
            distance: Math.min(group.distance, distance),
          };
        } else if (topGroups.length < MAX_TRACKED_MATCHES) {
          topGroups.push({ ...matchRange, distance });
        } else {
          const farthestIndex = findFarthestGroupIndex(topGroups);
          const farthestGroup = topGroups[farthestIndex];
          if (farthestGroup && distance < farthestGroup.distance) {
            topGroups.splice(farthestIndex, 1, { ...matchRange, distance });
          }
        }
      }
      if (
        !bestMatch ||
        bestComparison.quality > bestMatch.quality ||
        (bestComparison.quality === bestMatch.quality && distance < bestMatch.distance) ||
        (bestComparison.quality === bestMatch.quality &&
          distance === bestMatch.distance &&
          Math.abs(span - preferredSpan) <
            Math.abs(bestMatch.endLine - bestMatch.startLine + 1 - preferredSpan))
      ) {
        bestMatch = {
          startLine,
          endLine,
          snippet: matchedSnippet,
          quality: bestComparison.quality,
          distance,
          reconstruction: reconstructionUsed,
        };
      }
    }
  }

  if (!bestMatch) {
    return null;
  }
  // A fragment of the recorded text is not the recalled text. The heading/list and
  // capped-snippet reconstruction paths rebuild it, so they stay supported.
  if (bestMatch.quality < 2 && !bestMatch.reconstruction) {
    return null;
  }
  // Equally close matches of equal quality at distinct places leave the stored range
  // unresolved, so orphan the candidate instead of deciding it by span.
  const nearestDistance = Math.min(...topGroups.map((group) => group.distance));
  const nearestGroups = topGroups.filter((group) => group.distance === nearestDistance);
  if (nearestGroups.length > 1) {
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

/** Marks every line that belongs to a managed dreaming block, markers included. */
function resolveManagedFenceLines(lines: string[]): boolean[] {
  const managed: boolean[] = [];
  let insideFence = false;
  for (const line of lines) {
    const isStart = DREAMING_FENCE_START_RE.test(line);
    const isEnd = DREAMING_FENCE_END_RE.test(line);
    managed.push(isStart || isEnd || insideFence);
    insideFence = isStart ? true : isEnd ? false : insideFence;
  }
  return managed;
}

function lineRangeOverlapsDreamingFence(
  lines: string[],
  startLine: number,
  endLine: number,
): boolean {
  if (lines.length === 0) {
    return false;
  }
  const safeStart = Math.max(1, Math.min(startLine, lines.length));
  const safeEnd = Math.max(safeStart, Math.min(endLine, lines.length));
  const managed = resolveManagedFenceLines(lines);
  for (let line = safeStart; line <= safeEnd; line += 1) {
    if (managed[line - 1]) {
      return true;
    }
  }
  return false;
}

export async function rehydratePromotionCandidate(
  workspaceDir: string,
  candidate: PromotionCandidate,
): Promise<PromotionCandidate | null> {
  const sourcePaths = resolveShortTermSourcePathCandidates(workspaceDir, candidate.path);
  for (const sourcePath of sourcePaths) {
    let rawSource: string;
    try {
      rawSource = await fs.readFile(sourcePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        continue;
      }
      throw err;
    }

    const lines = rawSource.split(/\r?\n/);
    const relocated = relocateCandidateRange(lines, candidate);
    if (!relocated) {
      continue;
    }
    // Managed dreaming blocks in daily memory files are scratchwork, not durable
    // content. If rehydration lands inside an openclaw:dreaming fence (for example
    // because file edits shifted lines between ranking and apply), refuse the
    // candidate so dream artifacts cannot be promoted into MEMORY.md.
    if (lineRangeOverlapsDreamingFence(lines, relocated.startLine, relocated.endLine)) {
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

import { asNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isOffsetInProtectedRanges,
  type PlainTextToolCallNameMatcher,
  type PlainTextToolCallProtectedRangeResolver,
} from "./contracts.js";
import { skipLineIndentation, skipWhitespace, utf8ByteLengthWithinLimit } from "./grammar.js";
import { scanPlainTextToolCall, type PlainTextToolCallScan } from "./payload.js";
import type { PlainTextToolCallMessageProjection } from "./promote.js";
import {
  advanceProtectionScanState,
  createProtectionScanState,
  resolveProtectionFastPath,
  type ProtectionScanState,
} from "./protection-fast-path.js";
import { consumeRemovedLineEnd, MAX_PAYLOAD_BYTES } from "./stream-normalizer-suppression.js";

// Bounded per stream: event snapshots and scrubbed snapshots are separate anchor families.
const MAX_SCRUB_REUSES = 2;

export type TextRange = { end: number; start: number };
export type StandalonePlainTextToolCallCandidate = {
  parts: Array<{ contentIndex: number; end: number; start: number }>;
  text: string;
};
type ScannedCallSequence = TextRange & { activeStart?: number; overCap: boolean };

export function extractStandaloneCandidate(
  message: unknown,
  requireAssistantRole = false,
): StandalonePlainTextToolCallCandidate | undefined {
  const record = asOptionalObjectRecord(message);
  if (!record || (requireAssistantRole && record.role !== "assistant")) {
    return undefined;
  }
  if (typeof record.content === "string") {
    return record.content.trim() ? { text: record.content, parts: [] } : undefined;
  }
  if (!Array.isArray(record.content)) {
    return undefined;
  }
  const candidate: StandalonePlainTextToolCallCandidate = { text: "", parts: [] };
  for (const [contentIndex, block] of record.content.entries()) {
    const value = asOptionalObjectRecord(block);
    if (!value) {
      return undefined;
    }
    if (value.type !== "text") {
      continue;
    }
    if (typeof value.text !== "string") {
      return undefined;
    }
    const start = candidate.text.length;
    candidate.text += value.text;
    candidate.parts.push({ contentIndex, start, end: candidate.text.length });
  }
  return candidate.text.trim() ? candidate : undefined;
}

function scannedCall(scan: PlainTextToolCallScan) {
  if (scan.kind === "complete") {
    return {
      end: scan.end,
      incomplete: false,
      overCap: scan.overCap,
      payloadStart: scan.payloadStart,
    };
  }
  if (scan.overCap && scan.payloadStart !== undefined) {
    return {
      end: scan.kind === "prefix" ? scan.next : scan.at,
      incomplete: scan.kind === "prefix",
      overCap: true,
      payloadStart: scan.payloadStart,
    };
  }
  return null;
}

export function scanHasNamedCandidate(scan: PlainTextToolCallScan): boolean {
  return [scan.json, scan.xmlish].some((branch) => {
    const name = (branch.kind === "complete" ? branch : branch.candidate)?.name;
    return name !== undefined && name.end > name.start;
  });
}

function findUtf8OverCapOffset(text: string, start: number): number | null {
  let bytes = 0;
  for (let index = start; index < text.length;) {
    const code = text.codePointAt(index) ?? 0;
    index += code > 0xffff ? 2 : 1;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes > MAX_PAYLOAD_BYTES) {
      return index;
    }
  }
  return null;
}

export function findCandidateCallSequences(
  candidate: StandalonePlainTextToolCallCandidate,
  matcher: PlainTextToolCallNameMatcher,
  resolveProtectedRanges?: PlainTextToolCallProtectedRangeResolver,
): ScannedCallSequence[] {
  const {
    text,
    boundaries: structuralBoundaries,
    structuralLineBreaks,
  } = createCandidateScanView(candidate);
  const protectedRanges = resolveProtectedRanges?.(text) ?? [];
  const sequences: ScannedCallSequence[] = [];
  const structuralBoundarySet = new Set(structuralBoundaries);
  let structuralBoundaryIndex = 0;
  let index = 0;
  while (index < text.length) {
    const lineStart =
      index === 0 ||
      text[index - 1] === "\n" ||
      text[index - 1] === "\r" ||
      structuralBoundarySet.has(index);
    if (!lineStart) {
      index += 1;
      continue;
    }
    const sequenceStart = index;
    let callStart = skipLineIndentation(text, index);
    if (isOffsetInProtectedRanges(callStart, protectedRanges)) {
      index += 1;
      continue;
    }
    let sequenceEnd = callStart;
    let hasOverCap = false;
    let activeStart: number | undefined;
    let callCount = 0;
    const first = scanPlainTextToolCall(text, callStart, {
      matcher,
      maxPayloadBytes: MAX_PAYLOAD_BYTES,
      structuralLineBreaks,
    });
    let call = scannedCall(first);
    if (!call && first.kind === "prefix" && scanHasNamedCandidate(first)) {
      activeStart = callStart;
      callCount = 1;
      sequenceEnd = text.length;
    }
    while (call && callStart < text.length) {
      if (call.incomplete && call.overCap) {
        const overCapOffset = findUtf8OverCapOffset(text, call.payloadStart);
        while (
          structuralBoundaryIndex < structuralBoundaries.length &&
          (structuralBoundaries[structuralBoundaryIndex] ?? 0) < (overCapOffset ?? Infinity)
        ) {
          structuralBoundaryIndex += 1;
        }
        let boundary: number | undefined;
        while (structuralBoundaryIndex < structuralBoundaries.length) {
          const offset = structuralBoundaries[structuralBoundaryIndex];
          structuralBoundaryIndex += 1;
          const boundaryScan =
            offset === undefined
              ? undefined
              : scanPlainTextToolCall(text, skipLineIndentation(text, offset), {
                  matcher,
                  maxPayloadBytes: MAX_PAYLOAD_BYTES,
                  structuralLineBreaks,
                });
          if (boundaryScan && scannedCall(boundaryScan)) {
            boundary = offset;
            break;
          }
        }
        if (boundary !== undefined) {
          call.end = boundary;
          call.incomplete = false;
        }
      }
      callCount += 1;
      hasOverCap ||= call.overCap;
      sequenceEnd = consumeRemovedLineEnd(text, call.end);
      if (call.incomplete) {
        activeStart = callStart;
        break;
      }
      const nextStart = skipWhitespace(text, call.end);
      if (nextStart >= text.length) {
        break;
      }
      if (isOffsetInProtectedRanges(nextStart, protectedRanges)) {
        break;
      }
      const nextScan = scanPlainTextToolCall(text, nextStart, {
        matcher,
        maxPayloadBytes: MAX_PAYLOAD_BYTES,
        structuralLineBreaks,
      });
      const next = scannedCall(nextScan);
      if (!next) {
        if (nextScan.kind === "prefix" && scanHasNamedCandidate(nextScan)) {
          activeStart = nextStart;
          sequenceEnd = text.length;
        }
        break;
      }
      callStart = nextStart;
      call = next;
    }
    if (callCount > 0) {
      const aggregateOverCap =
        utf8ByteLengthWithinLimit(text, sequenceStart, sequenceEnd, MAX_PAYLOAD_BYTES) === null;
      sequences.push({
        start: sequenceStart,
        end: sequenceEnd,
        ...(activeStart === undefined ? {} : { activeStart }),
        overCap: hasOverCap || aggregateOverCap,
      });
      index = Math.max(sequenceEnd, index + 1);
      continue;
    }
    index = Math.max(index + 1, first.next);
  }
  return sequences;
}

/** Finds an unfinished marker at a candidate boundary; its suffix stays private. */
export function findTrailingCallPrefix(
  candidate: StandalonePlainTextToolCallCandidate,
  matcher: PlainTextToolCallNameMatcher,
  resolveProtectedRanges?: PlainTextToolCallProtectedRangeResolver,
  start = 0,
): { named: boolean; start: number } | undefined {
  const { text, boundaries, structuralLineBreaks } = createCandidateScanView(candidate);
  const protectedRanges = resolveProtectedRanges?.(text) ?? [];
  const boundarySet = new Set(boundaries);
  let tail: { named: boolean; start: number } | undefined;
  let index = start;
  while (index < text.length) {
    if (
      index !== start &&
      text[index - 1] !== "\n" &&
      text[index - 1] !== "\r" &&
      !boundarySet.has(index)
    ) {
      index += 1;
      continue;
    }
    const callStart = skipLineIndentation(text, index);
    if (isOffsetInProtectedRanges(callStart, protectedRanges)) {
      index += 1;
      continue;
    }
    const scan = scanPlainTextToolCall(text, callStart, {
      matcher,
      maxPayloadBytes: MAX_PAYLOAD_BYTES,
      structuralLineBreaks,
    });
    if (scan.kind === "prefix" && !scannedCall(scan)) {
      tail = { named: scanHasNamedCandidate(scan), start: index };
    }
    index = Math.max(index + 1, scan.next);
  }
  return tail;
}

export function createCandidateScanView(candidate: StandalonePlainTextToolCallCandidate) {
  const boundaries = candidate.parts.slice(1).map((part) => part.start);
  return {
    boundaries,
    text: candidate.text,
    ...(boundaries.length > 0
      ? { structuralLineBreaks: { lineBreakOffsets: new Set(boundaries) } }
      : {}),
  };
}

export function createRangeRemover(ranges: readonly TextRange[]) {
  let rangeIndex = 0;
  return (text: string, offset = 0): string => {
    let result = "";
    let cursor = 0;
    const endOffset = offset + text.length;
    while ((ranges[rangeIndex]?.end ?? Infinity) <= offset) {
      rangeIndex += 1;
    }
    for (
      let range = ranges[rangeIndex];
      range && range.start < endOffset;
      range = ranges[rangeIndex]
    ) {
      const start = Math.max(0, range.start - offset);
      const end = Math.min(text.length, range.end - offset);
      if (end > start) {
        result += text.slice(cursor, Math.max(cursor, start));
        cursor = Math.max(cursor, end);
      }
      if (range.end > endOffset) {
        break;
      }
      rangeIndex += 1;
    }
    return cursor ? result + text.slice(cursor) : text;
  };
}

function projectRangesOntoMessage(
  record: Record<string, unknown>,
  candidate: StandalonePlainTextToolCallCandidate,
  ranges: readonly TextRange[],
  preserveEmptyTextBlocks: boolean,
): PlainTextToolCallMessageProjection {
  const removeRanges = createRangeRemover(ranges);
  if (typeof record.content === "string") {
    return {
      message: { ...record, content: removeRanges(record.content) },
      sourceToProjectedContentIndex: new Map([[0, 0]]),
    };
  }
  if (!Array.isArray(record.content)) {
    return { message: record, sourceToProjectedContentIndex: new Map() };
  }
  const parts = new Map(candidate.parts.map((part) => [part.contentIndex, part]));
  const content: unknown[] = [];
  const sourceToProjectedContentIndex = new Map<number, number>();
  for (const [index, block] of record.content.entries()) {
    const part = parts.get(index);
    const blockRecord = asOptionalObjectRecord(block);
    if (!part || blockRecord?.type !== "text" || typeof blockRecord.text !== "string") {
      sourceToProjectedContentIndex.set(index, content.length);
      content.push(block);
      continue;
    }
    const text = removeRanges(blockRecord.text, part.start);
    if (text || preserveEmptyTextBlocks) {
      sourceToProjectedContentIndex.set(index, content.length);
      content.push({ ...blockRecord, text });
    }
  }
  return { message: { ...record, content }, sourceToProjectedContentIndex };
}

/** Projection plus the removal ranges it applied, including any open tail (scrub-reuse input). */
type ScrubProjection = PlainTextToolCallMessageProjection & { ranges: ScannedCallSequence[] };

/** Scrubs unsafe or mixed calls and maps each retained source content block. */
export function projectScrubbedPlainTextToolCallMessage(params: {
  forceIncompleteCandidates?: boolean;
  forceKnownCandidates?: boolean;
  matcher: PlainTextToolCallNameMatcher;
  message: unknown;
  preserveEmptyTextBlocks?: boolean;
  resolveProtectedRanges?: PlainTextToolCallProtectedRangeResolver;
  requireAssistantRole?: boolean;
}): ScrubProjection | undefined {
  const record = asOptionalObjectRecord(params.message);
  const candidate = extractStandaloneCandidate(
    params.message,
    params.requireAssistantRole === true,
  );
  if (!record || !candidate) {
    return undefined;
  }
  const sequences = findCandidateCallSequences(
    candidate,
    params.matcher,
    params.resolveProtectedRanges,
  );
  const visibleOutsideCalls = Boolean(createRangeRemover(sequences)(candidate.text).trim());
  const ranges = sequences.filter(
    (sequence) =>
      params.forceKnownCandidates ||
      sequence.overCap ||
      visibleOutsideCalls ||
      (params.forceIncompleteCandidates && sequence.activeStart !== undefined),
  );
  return ranges.length > 0
    ? {
        ...projectRangesOntoMessage(
          record,
          candidate,
          ranges,
          params.preserveEmptyTextBlocks === true,
        ),
        ranges,
      }
    : undefined;
}

export function findPotentialCallStart(
  text: string,
  atLineStart: boolean,
  matcher: PlainTextToolCallNameMatcher,
  isProtected?: (offset: number) => boolean,
): number | null {
  for (let index = 0; index < text.length;) {
    const lineStart =
      (index === 0 && atLineStart) || text[index - 1] === "\n" || text[index - 1] === "\r";
    if (!lineStart) {
      index += 1;
      continue;
    }
    const start = skipLineIndentation(text, index);
    const first = text[start];
    // Brackets, XML and Harmony channels are the only openings. An empty tail
    // still needs the scanner: indentation may precede a split marker.
    if (first !== undefined && !"[<caf".includes(first)) {
      index = start + 1;
      continue;
    }
    if (isProtected?.(start)) {
      index += 1;
      continue;
    }
    const scan = scanPlainTextToolCall(text, start, {
      matcher,
      maxPayloadBytes: MAX_PAYLOAD_BYTES,
    });
    if (scan.kind === "prefix" || scannedCall(scan)) {
      return index;
    }
    index = Math.max(index + 1, scan.next);
  }
  return null;
}

export function orderByContentIndex(
  events: readonly unknown[],
  message: Record<string, unknown>,
): unknown[] {
  const contentLength = Array.isArray(message.content) ? message.content.length : 0;
  const order = (event: unknown) => {
    const index = asNonNegativeInteger(asOptionalObjectRecord(event)?.contentIndex);
    return index !== undefined && index < contentLength ? index : contentLength;
  };
  return events.toSorted((left, right) => order(left) - order(right));
}

export function nextAtLineStart(previous: boolean, text: string): boolean {
  if (!text) {
    return previous;
  }
  return text.endsWith("\n") || text.endsWith("\r");
}

/** Owns per-stream snapshot reuse; ambiguous grammar and Markdown retain canonical scrubbing. */
export function createForcedScrubSnapshot(options: {
  matcher: PlainTextToolCallNameMatcher;
  resolveProtectedRanges?: PlainTextToolCallProtectedRangeResolver;
  protectedRangesFenceCompatible?: boolean;
}) {
  // Settled prefix ranges cannot change ownership. Only newly appended candidates need a
  // verdict; carry fence state so literal examples do not reparse the growing snapshot.
  const scrubReuses: {
    parts: StandalonePlainTextToolCallCandidate["parts"];
    protectionScan: ProtectionScanState | undefined;
    ranges: ScannedCallSequence[];
    text: string;
  }[] = [];

  // Check the same line, content-block, and post-call boundaries as the canonical scan.
  const scrubScanIsSettled = (
    candidate: StandalonePlainTextToolCallCandidate,
    ranges: readonly ScannedCallSequence[],
  ): boolean => {
    if (
      // A trailing empty block can acquire a call independently of the preceding line.
      candidate.parts.at(-1)?.start === candidate.text.length ||
      ranges.some((range) => range.activeStart !== undefined || range.end === candidate.text.length)
    ) {
      return false;
    }
    // Only proven fences have immutable protection. Inline code inside an unresolved image
    // reference can lose ownership when a later definition arrives; custom resolvers can too.
    const protectedAt =
      options.resolveProtectedRanges && options.protectedRangesFenceCompatible
        ? resolveProtectionFastPath(createProtectionScanState(), candidate.text)
        : undefined;
    if (options.resolveProtectedRanges && !protectedAt) {
      return false;
    }
    const view = createCandidateScanView(candidate);
    const boundarySet = new Set(view.boundaries);
    const settled = (start: number): boolean => {
      if (protectedAt?.(start)) {
        return true;
      }
      const scan = scanPlainTextToolCall(view.text, start, {
        matcher: options.matcher,
        maxPayloadBytes: MAX_PAYLOAD_BYTES,
        structuralLineBreaks: view.structuralLineBreaks,
      });
      // A prefix can still complete, and an unsettled complete still reads the text end for its
      // trailing line end; both verdicts can change when bytes follow.
      return scan.kind === "complete" ? scan.settled : scan.kind === "invalid";
    };
    for (let index = 0; index < view.text.length; index += 1) {
      if (
        index === 0 ||
        view.text[index - 1] === "\n" ||
        view.text[index - 1] === "\r" ||
        boundarySet.has(index)
      ) {
        if (!settled(skipLineIndentation(view.text, index))) {
          return false;
        }
      }
    }
    for (const range of ranges) {
      if (!settled(skipWhitespace(view.text, range.end))) {
        return false;
      }
    }
    return true;
  };

  const partsContinueCandidate = (
    parts: StandalonePlainTextToolCallCandidate["parts"],
    previous: StandalonePlainTextToolCallCandidate["parts"],
    suffixLength: number,
  ): boolean => {
    if (parts.length === 0 || parts.length !== previous.length) {
      return false;
    }
    return parts.every((part, index) => {
      const before = previous[index];
      return (
        before !== undefined &&
        part.contentIndex === before.contentIndex &&
        part.start === before.start &&
        part.end === before.end + (index === parts.length - 1 ? suffixLength : 0)
      );
    });
  };

  const forcedScrubSnapshot = (
    value: unknown,
    preserveEmptyTextBlocks: boolean,
  ): ScrubProjection | undefined => {
    const candidate = extractStandaloneCandidate(value);
    const record = asOptionalObjectRecord(value);
    if (candidate && record) {
      for (const [index, reuse] of scrubReuses.entries()) {
        const text = candidate.text;
        if (text.length <= reuse.text.length || !text.startsWith(reuse.text)) {
          continue;
        }
        const suffix = text.slice(reuse.text.length);
        let protectedAt = reuse.protectionScan
          ? resolveProtectionFastPath(reuse.protectionScan, suffix)
          : undefined;
        if (!protectedAt && reuse.protectionScan) {
          // An unfinished final line must not discard proven fences on earlier lines.
          // Candidates in that tail still fall through to canonical scrubbing.
          const tailStart = suffix.lastIndexOf("\n") + 1;
          const completed = resolveProtectionFastPath(
            reuse.protectionScan,
            suffix.slice(0, tailStart),
          );
          if (completed) {
            protectedAt = (offset) => offset < tailStart && completed(offset);
          }
        }
        if (
          findPotentialCallStart(
            suffix,
            nextAtLineStart(true, reuse.text),
            options.matcher,
            protectedAt,
          ) !== null
        ) {
          continue;
        }
        if (!partsContinueCandidate(candidate.parts, reuse.parts, suffix.length)) {
          continue;
        }
        const ranges = reuse.ranges;
        if (reuse.protectionScan) {
          advanceProtectionScanState(reuse.protectionScan, suffix);
        }
        scrubReuses.splice(index, 1);
        scrubReuses.unshift({ ...reuse, parts: candidate.parts, ranges, text });
        return {
          ...projectRangesOntoMessage(record, candidate, ranges, preserveEmptyTextBlocks),
          ranges,
        };
      }
    }
    const projection = projectScrubbedPlainTextToolCallMessage({
      forceKnownCandidates: true,
      matcher: options.matcher,
      message: value,
      preserveEmptyTextBlocks,
      resolveProtectedRanges: options.resolveProtectedRanges,
    });
    if (projection && candidate && scrubScanIsSettled(candidate, projection.ranges)) {
      const existing = scrubReuses.findIndex((reuse) => reuse.text === candidate.text);
      if (existing !== -1) {
        scrubReuses.splice(existing, 1);
      }
      const protectionScan = options.resolveProtectedRanges
        ? createProtectionScanState()
        : undefined;
      if (protectionScan) {
        advanceProtectionScanState(protectionScan, candidate.text);
      }
      scrubReuses.unshift({
        parts: candidate.parts,
        protectionScan,
        ranges: projection.ranges,
        text: candidate.text,
      });
      if (scrubReuses.length > MAX_SCRUB_REUSES) {
        scrubReuses.length = MAX_SCRUB_REUSES;
      }
    }
    return projection;
  };

  return forcedScrubSnapshot;
}

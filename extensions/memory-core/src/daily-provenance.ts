import { createHash } from "node:crypto";
import type { MemoryEntryProvenance } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export type DailyProvenanceOrigin = "agent" | "untrusted";

export type DailyProvenanceSegment = {
  startOffset: number;
  endOffset: number;
  contentHash: string;
  originClass: DailyProvenanceOrigin;
  observedAt: number;
};

export type DailyProvenanceRecord = {
  fileHash: string;
  originClass: DailyProvenanceOrigin;
  observedAt: number;
  segments?: DailyProvenanceSegment[];
};

export function hashDailyMemoryContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function segmentFor(params: {
  content: string;
  startOffset: number;
  endOffset: number;
  originClass: DailyProvenanceOrigin;
  observedAt: number;
}): DailyProvenanceSegment {
  return {
    startOffset: params.startOffset,
    endOffset: params.endOffset,
    contentHash: hashDailyMemoryContent(params.content.slice(params.startOffset, params.endOffset)),
    originClass: params.originClass,
    observedAt: params.observedAt,
  };
}

function recordFromSegments(params: {
  content: string;
  segments: DailyProvenanceSegment[];
  observedAt: number;
}): DailyProvenanceRecord {
  return {
    fileHash: hashDailyMemoryContent(params.content),
    originClass: params.segments.some((segment) => segment.originClass === "untrusted")
      ? "untrusted"
      : "agent",
    observedAt: params.observedAt,
    segments: params.segments,
  };
}

function verifiedSegments(
  content: string,
  record: DailyProvenanceRecord,
): DailyProvenanceSegment[] | null {
  if (record.fileHash !== hashDailyMemoryContent(content)) {
    return null;
  }
  if (!record.segments) {
    return content.length === 0
      ? []
      : [
          segmentFor({
            content,
            startOffset: 0,
            endOffset: content.length,
            originClass: record.originClass,
            observedAt: record.observedAt,
          }),
        ];
  }
  let cursor = 0;
  for (const segment of record.segments) {
    if (
      !Number.isInteger(segment.startOffset) ||
      !Number.isInteger(segment.endOffset) ||
      segment.startOffset !== cursor ||
      segment.endOffset <= segment.startOffset ||
      segment.endOffset > content.length ||
      (segment.originClass !== "agent" && segment.originClass !== "untrusted") ||
      !Number.isFinite(segment.observedAt) ||
      segment.contentHash !==
        hashDailyMemoryContent(content.slice(segment.startOffset, segment.endOffset))
    ) {
      return null;
    }
    cursor = segment.endOffset;
  }
  return cursor === content.length ? record.segments : null;
}

export function buildDailyProvenanceRecord(params: {
  existing?: DailyProvenanceRecord;
  contentBefore: string;
  contentAfter: string;
  originClass: DailyProvenanceOrigin;
  observedAt: number;
}): DailyProvenanceRecord {
  const appendOnly = params.contentAfter.startsWith(params.contentBefore);
  let segments: DailyProvenanceSegment[];

  if (!appendOnly) {
    segments =
      params.contentAfter.length === 0
        ? []
        : [
            segmentFor({
              content: params.contentAfter,
              startOffset: 0,
              endOffset: params.contentAfter.length,
              originClass: "untrusted",
              observedAt: params.observedAt,
            }),
          ];
  } else {
    const verifiedExisting = params.existing
      ? verifiedSegments(params.contentBefore, params.existing)
      : undefined;
    const baselineOrigin = params.existing?.originClass ?? "agent";
    segments =
      verifiedExisting ??
      (params.contentBefore.length === 0
        ? []
        : [
            segmentFor({
              content: params.contentBefore,
              startOffset: 0,
              endOffset: params.contentBefore.length,
              originClass: baselineOrigin,
              observedAt: params.existing?.observedAt ?? params.observedAt,
            }),
          ]);
    if (params.contentAfter.length > params.contentBefore.length) {
      segments = [
        ...segments,
        segmentFor({
          content: params.contentAfter,
          startOffset: params.contentBefore.length,
          endOffset: params.contentAfter.length,
          originClass: params.originClass,
          observedAt: params.observedAt,
        }),
      ];
    }
  }

  return recordFromSegments({
    content: params.contentAfter,
    segments,
    observedAt: params.observedAt,
  });
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(a: string, b: string, prefixLength: number): number {
  const limit = Math.min(a.length, b.length) - prefixLength;
  let count = 0;
  while (count < limit && a[a.length - count - 1] === b[b.length - count - 1]) {
    count += 1;
  }
  return count;
}

function clippedSegment(params: {
  content: string;
  source: DailyProvenanceSegment;
  sourceStart: number;
  sourceEnd: number;
  targetStart: number;
}): DailyProvenanceSegment | undefined {
  const start = Math.max(params.source.startOffset, params.sourceStart);
  const end = Math.min(params.source.endOffset, params.sourceEnd);
  if (end <= start) {
    return undefined;
  }
  const startOffset = params.targetStart + (start - params.sourceStart);
  const endOffset = startOffset + (end - start);
  return segmentFor({
    content: params.content,
    startOffset,
    endOffset,
    originClass: params.source.originClass,
    observedAt: params.source.observedAt,
  });
}

export function rebaseDailyProvenanceRecord(params: {
  existing?: DailyProvenanceRecord;
  contentBefore: string;
  contentAfter: string;
  observedAt: number;
}): DailyProvenanceRecord {
  const prior =
    (params.existing && verifiedSegments(params.contentBefore, params.existing)) ??
    (params.contentBefore.length === 0
      ? []
      : [
          segmentFor({
            content: params.contentBefore,
            startOffset: 0,
            endOffset: params.contentBefore.length,
            originClass: params.existing?.originClass ?? "agent",
            observedAt: params.existing?.observedAt ?? params.observedAt,
          }),
        ]);
  const prefixLength = commonPrefixLength(params.contentBefore, params.contentAfter);
  const suffixLength = commonSuffixLength(params.contentBefore, params.contentAfter, prefixLength);
  const beforeSuffixStart = params.contentBefore.length - suffixLength;
  const afterSuffixStart = params.contentAfter.length - suffixLength;
  const prefixSegments = prior.flatMap((segment) => {
    const clipped = clippedSegment({
      content: params.contentAfter,
      source: segment,
      sourceStart: 0,
      sourceEnd: prefixLength,
      targetStart: 0,
    });
    return clipped ? [clipped] : [];
  });
  const changedSegments =
    afterSuffixStart > prefixLength
      ? [
          segmentFor({
            content: params.contentAfter,
            startOffset: prefixLength,
            endOffset: afterSuffixStart,
            originClass: "untrusted",
            observedAt: params.observedAt,
          }),
        ]
      : [];
  const suffixSegments = prior.flatMap((segment) => {
    const clipped = clippedSegment({
      content: params.contentAfter,
      source: segment,
      sourceStart: beforeSuffixStart,
      sourceEnd: params.contentBefore.length,
      targetStart: afterSuffixStart,
    });
    return clipped ? [clipped] : [];
  });
  return recordFromSegments({
    content: params.contentAfter,
    segments: [...prefixSegments, ...changedSegments, ...suffixSegments],
    observedAt: params.observedAt,
  });
}

function lineOffsetRanges(content: string): Array<{ startOffset: number; endOffset: number }> {
  const ranges: Array<{ startOffset: number; endOffset: number }> = [];
  let startOffset = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "\n") {
      continue;
    }
    const contentEnd = index > startOffset && content[index - 1] === "\r" ? index - 1 : index;
    ranges.push({ startOffset, endOffset: contentEnd });
    startOffset = index + 1;
  }
  ranges.push({ startOffset, endOffset: content.length });
  return ranges;
}

export function resolveDailyLineProvenance(params: {
  content: string;
  record?: DailyProvenanceRecord;
  defaultObservedAt: number;
}): MemoryEntryProvenance[] {
  const ranges = lineOffsetRanges(params.content);
  if (!params.record) {
    return ranges.map(() => ({
      originClass: "agent",
      sessionKind: "unknown",
      observedAt: params.defaultObservedAt,
    }));
  }

  const segments = verifiedSegments(params.content, params.record);
  if (!segments) {
    const originClass = params.record.originClass === "untrusted" ? "untrusted" : "agent";
    const observedAt =
      originClass === "untrusted" ? params.record.observedAt : params.defaultObservedAt;
    return ranges.map(() => ({ originClass, sessionKind: "unknown", observedAt }));
  }

  return ranges.map((range) => {
    const overlapping = segments.filter((segment) => {
      if (range.startOffset === range.endOffset) {
        return segment.startOffset <= range.startOffset && segment.endOffset >= range.endOffset;
      }
      return segment.startOffset < range.endOffset && segment.endOffset > range.startOffset;
    });
    const originClass = overlapping.some((segment) => segment.originClass === "untrusted")
      ? "untrusted"
      : "agent";
    const observedAt =
      overlapping.length > 0
        ? Math.max(...overlapping.map((segment) => segment.observedAt))
        : params.defaultObservedAt;
    return { originClass, sessionKind: "unknown", observedAt };
  });
}

export function resolveDailyRangeProvenance(params: {
  content: string;
  record?: DailyProvenanceRecord;
  startLine: number;
  endLine: number;
  defaultObservedAt: number;
}): MemoryEntryProvenance {
  const lines = resolveDailyLineProvenance(params).slice(
    Math.max(0, params.startLine - 1),
    Math.max(params.startLine, params.endLine),
  );
  return {
    originClass: lines.some((line) => line.originClass === "untrusted") ? "untrusted" : "agent",
    sessionKind: "unknown",
    observedAt: Math.max(params.defaultObservedAt, ...lines.map((line) => line.observedAt)),
  };
}

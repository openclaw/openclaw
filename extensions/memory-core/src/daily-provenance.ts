import { createHash } from "node:crypto";
import type { MemoryEntryProvenance } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type {
  MemoryArtifactProvenance,
  MemoryArtifactProvenanceSegment,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";

export type DailyProvenanceRecord = MemoryArtifactProvenance;

export function hashDailyMemoryContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function normalizeMemoryObservedAt(value: number, fallback = 0): number {
  const candidate = Number.isFinite(value) ? value : fallback;
  if (!Number.isFinite(candidate)) {
    return 0;
  }
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(candidate)));
}

function verifiedSegments(
  content: string,
  record: DailyProvenanceRecord,
): MemoryArtifactProvenanceSegment[] | null {
  if (record.fileHash !== hashDailyMemoryContent(content)) {
    return null;
  }
  if (!record.segments) {
    return content.length === 0
      ? []
      : [
          {
            startOffset: 0,
            endOffset: content.length,
            contentHash: hashDailyMemoryContent(content),
            originClass: record.originClass,
            observedAt: record.observedAt,
          },
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
  const defaultObservedAt = normalizeMemoryObservedAt(params.defaultObservedAt);
  if (!params.record) {
    return ranges.map(() => ({
      originClass: "agent",
      sessionKind: "unknown",
      observedAt: defaultObservedAt,
    }));
  }

  const segments = verifiedSegments(params.content, params.record);
  if (!segments) {
    const originClass = params.record.originClass === "untrusted" ? "untrusted" : "agent";
    const observedAt =
      originClass === "untrusted"
        ? normalizeMemoryObservedAt(params.record.observedAt, defaultObservedAt)
        : defaultObservedAt;
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
        ? normalizeMemoryObservedAt(
            Math.max(...overlapping.map((segment) => segment.observedAt)),
            defaultObservedAt,
          )
        : defaultObservedAt;
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
    observedAt: normalizeMemoryObservedAt(
      Math.max(params.defaultObservedAt, ...lines.map((line) => line.observedAt)),
    ),
  };
}

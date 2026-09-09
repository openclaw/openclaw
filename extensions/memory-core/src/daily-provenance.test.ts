import { describe, expect, it } from "vitest";
import {
  hashDailyMemoryContent,
  normalizeMemoryObservedAt,
  resolveDailyLineProvenance,
  resolveDailyRangeProvenance,
  type DailyProvenanceRecord,
} from "./daily-provenance.js";

type SegmentSpec = {
  text: string;
  originClass: "agent" | "untrusted";
  observedAt: number;
};

function recordFromSegments(specs: SegmentSpec[]): {
  content: string;
  record: DailyProvenanceRecord;
} {
  const content = specs.map((spec) => spec.text).join("");
  let startOffset = 0;
  const segments = specs.map((spec) => {
    const segment = {
      startOffset,
      endOffset: startOffset + spec.text.length,
      contentHash: hashDailyMemoryContent(spec.text),
      originClass: spec.originClass,
      observedAt: spec.observedAt,
    };
    startOffset = segment.endOffset;
    return segment;
  });
  return {
    content,
    record: {
      fileHash: hashDailyMemoryContent(content),
      originClass: segments.some((segment) => segment.originClass === "untrusted")
        ? "untrusted"
        : "agent",
      observedAt: Math.max(0, ...segments.map((segment) => segment.observedAt)),
      segments,
    },
  };
}

describe("daily memory provenance", () => {
  it("normalizes filesystem timestamps before STRICT SQLite storage", () => {
    const content = "trusted line\n";
    const staleRecord: DailyProvenanceRecord = {
      fileHash: hashDailyMemoryContent(content),
      originClass: "agent",
      observedAt: 1,
      segments: [],
    };

    const lines = resolveDailyLineProvenance({
      content,
      record: staleRecord,
      defaultObservedAt: 1_234.75,
    });

    expect(lines.every((line) => Number.isSafeInteger(line.observedAt))).toBe(true);
    expect(lines).toMatchObject([{ observedAt: 1_234 }, { observedAt: 1_234 }]);
    expect(normalizeMemoryObservedAt(Number.NaN, 5_678.9)).toBe(5_678);
  });

  it("keeps trusted lines promotable after a legacy quarantined file", () => {
    const { content, record } = recordFromSegments([
      { text: "untrusted line\n", originClass: "untrusted", observedAt: 1 },
      { text: "trusted line\n", originClass: "agent", observedAt: 2 },
    ]);

    expect(record.originClass).toBe("untrusted");
    expect(
      resolveDailyLineProvenance({ content, record, defaultObservedAt: 3 }).slice(0, 2),
    ).toMatchObject([
      { originClass: "untrusted", observedAt: 1 },
      { originClass: "agent", observedAt: 2 },
    ]);
    expect(
      resolveDailyRangeProvenance({
        content,
        record,
        startLine: 2,
        endLine: 2,
        defaultObservedAt: 3,
      }).originClass,
    ).toBe("agent");
  });

  it("does not let an untrusted append taint earlier trusted lines", () => {
    const { content, record } = recordFromSegments([
      { text: "trusted line\n", originClass: "agent", observedAt: 1 },
      { text: "untrusted line\n", originClass: "untrusted", observedAt: 2 },
    ]);

    expect(
      resolveDailyLineProvenance({ content, record, defaultObservedAt: 3 }).slice(0, 2),
    ).toMatchObject([{ originClass: "agent" }, { originClass: "untrusted" }]);
  });

  it("keeps a stale baseline quarantined while trusting the exact append", () => {
    const { content, record } = recordFromSegments([
      { text: "tampered line\n", originClass: "untrusted", observedAt: 1 },
      { text: "trusted append\n", originClass: "agent", observedAt: 2 },
    ]);

    expect(
      resolveDailyLineProvenance({ content, record, defaultObservedAt: 3 }).slice(0, 2),
    ).toMatchObject([{ originClass: "untrusted" }, { originClass: "agent" }]);
  });

  it("fails closed for a non-append rewrite", () => {
    const { content, record } = recordFromSegments([
      { text: "replacement line\n", originClass: "untrusted", observedAt: 2 },
    ]);

    expect(record.originClass).toBe("untrusted");
    expect(
      resolveDailyRangeProvenance({
        content,
        record,
        startLine: 1,
        endLine: 1,
        defaultObservedAt: 3,
      }).originClass,
    ).toBe("untrusted");
  });

  it("quarantines a line when trust changes in the middle of it", () => {
    const { content, record } = recordFromSegments([
      { text: "trusted", originClass: "agent", observedAt: 1 },
      { text: " untrusted\n", originClass: "untrusted", observedAt: 2 },
    ]);

    expect(
      resolveDailyRangeProvenance({
        content,
        record,
        startLine: 1,
        endLine: 1,
        defaultObservedAt: 3,
      }).originClass,
    ).toBe("untrusted");
  });

  it("preserves existing line trust across a managed block replacement", () => {
    const { content, record } = recordFromSegments([
      { text: "trusted line\n", originClass: "agent", observedAt: 1 },
      { text: "managed block\n", originClass: "untrusted", observedAt: 3 },
      { text: "quarantined line\n", originClass: "untrusted", observedAt: 2 },
    ]);

    expect(
      resolveDailyLineProvenance({ content, record, defaultObservedAt: 4 }).slice(0, 3),
    ).toMatchObject([
      { originClass: "agent" },
      { originClass: "untrusted" },
      { originClass: "untrusted" },
    ]);
  });
});

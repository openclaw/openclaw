import { describe, expect, it } from "vitest";
import {
  buildDailyProvenanceRecord,
  hashDailyMemoryContent,
  rebaseDailyProvenanceRecord,
  resolveDailyLineProvenance,
  resolveDailyRangeProvenance,
  type DailyProvenanceRecord,
} from "./daily-provenance.js";

describe("daily memory provenance", () => {
  it("keeps trusted lines promotable after a legacy quarantined file", () => {
    const before = "untrusted line\n";
    const after = `${before}trusted line\n`;
    const legacy: DailyProvenanceRecord = {
      fileHash: hashDailyMemoryContent(before),
      originClass: "untrusted",
      observedAt: 1,
    };
    const record = buildDailyProvenanceRecord({
      existing: legacy,
      contentBefore: before,
      contentAfter: after,
      originClass: "agent",
      observedAt: 2,
    });

    expect(record.originClass).toBe("untrusted");
    expect(
      resolveDailyLineProvenance({ content: after, record, defaultObservedAt: 3 }).slice(0, 2),
    ).toMatchObject([
      { originClass: "untrusted", observedAt: 1 },
      { originClass: "agent", observedAt: 2 },
    ]);
    expect(
      resolveDailyRangeProvenance({
        content: after,
        record,
        startLine: 2,
        endLine: 2,
        defaultObservedAt: 3,
      }).originClass,
    ).toBe("agent");
  });

  it("does not let an untrusted append taint earlier trusted lines", () => {
    const before = "trusted line\n";
    const first = buildDailyProvenanceRecord({
      contentBefore: "",
      contentAfter: before,
      originClass: "agent",
      observedAt: 1,
    });
    const after = `${before}untrusted line\n`;
    const record = buildDailyProvenanceRecord({
      existing: first,
      contentBefore: before,
      contentAfter: after,
      originClass: "untrusted",
      observedAt: 2,
    });

    expect(
      resolveDailyLineProvenance({ content: after, record, defaultObservedAt: 3 }).slice(0, 2),
    ).toMatchObject([{ originClass: "agent" }, { originClass: "untrusted" }]);
  });

  it("keeps a stale baseline quarantined while trusting the exact append", () => {
    const recordedContent = "recorded line\n";
    const record = buildDailyProvenanceRecord({
      contentBefore: "",
      contentAfter: recordedContent,
      originClass: "untrusted",
      observedAt: 1,
    });
    const contentBefore = "tampered line\n";
    const contentAfter = `${contentBefore}trusted append\n`;
    const next = buildDailyProvenanceRecord({
      existing: record,
      contentBefore,
      contentAfter,
      originClass: "agent",
      observedAt: 2,
    });

    expect(
      resolveDailyLineProvenance({
        content: contentAfter,
        record: next,
        defaultObservedAt: 3,
      }).slice(0, 2),
    ).toMatchObject([{ originClass: "untrusted" }, { originClass: "agent" }]);
  });

  it("fails closed for a non-append rewrite", () => {
    const record = buildDailyProvenanceRecord({
      contentBefore: "trusted line\n",
      contentAfter: "replacement line\n",
      originClass: "agent",
      observedAt: 2,
    });

    expect(record.originClass).toBe("untrusted");
    expect(
      resolveDailyRangeProvenance({
        content: "replacement line\n",
        record,
        startLine: 1,
        endLine: 1,
        defaultObservedAt: 3,
      }).originClass,
    ).toBe("untrusted");
  });

  it("quarantines a line when trust changes in the middle of it", () => {
    const before = "trusted";
    const first = buildDailyProvenanceRecord({
      contentBefore: "",
      contentAfter: before,
      originClass: "agent",
      observedAt: 1,
    });
    const after = `${before} untrusted\n`;
    const record = buildDailyProvenanceRecord({
      existing: first,
      contentBefore: before,
      contentAfter: after,
      originClass: "untrusted",
      observedAt: 2,
    });

    expect(
      resolveDailyRangeProvenance({
        content: after,
        record,
        startLine: 1,
        endLine: 1,
        defaultObservedAt: 3,
      }).originClass,
    ).toBe("untrusted");
  });

  it("preserves existing line trust across a managed block replacement", () => {
    const before = "trusted line\nquarantined line\n";
    const base = buildDailyProvenanceRecord({
      contentBefore: "",
      contentAfter: "trusted line\n",
      originClass: "agent",
      observedAt: 1,
    });
    const mixed = buildDailyProvenanceRecord({
      existing: base,
      contentBefore: "trusted line\n",
      contentAfter: before,
      originClass: "untrusted",
      observedAt: 2,
    });
    const after = "trusted line\nmanaged block\nquarantined line\n";
    const rebased = rebaseDailyProvenanceRecord({
      existing: mixed,
      contentBefore: before,
      contentAfter: after,
      observedAt: 3,
    });

    expect(
      resolveDailyLineProvenance({ content: after, record: rebased, defaultObservedAt: 4 }).slice(
        0,
        3,
      ),
    ).toMatchObject([
      { originClass: "agent" },
      { originClass: "untrusted" },
      { originClass: "untrusted" },
    ]);
  });
});

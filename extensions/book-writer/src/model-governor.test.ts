import { describe, expect, it } from "vitest";
import {
  estimateBookEndurance,
  estimateSchedule,
  evaluateModelEligibility,
  selectBestModel,
} from "./model-governor.js";
import type { MemoryPolicy, ModelBenchRecord } from "./types.js";

const policy: MemoryPolicy = {
  defaultGb: 64,
  idealGb: 80,
  premiumGb: 96,
  hardRejectGb: 110,
};

function record(model: string, peakMemoryGb: number, qualityScore: number): ModelBenchRecord {
  return {
    provider: "lmstudio",
    model,
    source: "measured",
    peakMemoryGb,
    tokensPerSecond: 20,
    stableContextTokens: 32768,
    crashRate: 0,
    qualityScore,
    measuredAt: "2026-05-14T00:00:00.000Z",
    notes: [],
  };
}

describe("book-writer model governor", () => {
  it("rejects models above the active memory cap", () => {
    const result = evaluateModelEligibility({
      record: record("large", 88, 0.9),
      policy,
      mode: "normal",
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons.join(" ")).toContain("normal cap 64 GB");
  });

  it("hard rejects models above the hard cap", () => {
    const result = evaluateModelEligibility({
      record: record("too-large", 124, 0.95),
      policy,
      mode: "premium",
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons.join(" ")).toContain("hard reject cap 110 GB");
  });

  it("selects the best eligible model under the current mode", () => {
    const result = selectBestModel({
      records: [record("small", 46, 0.74), record("daily", 52, 0.82), record("premium", 92, 0.9)],
      policy,
      mode: "normal",
    });

    expect(result.selected?.model).toBe("daily");
    expect(result.rejected).toEqual([
      { model: "premium", reasons: ["peak memory 92 GB exceeds normal cap 64 GB"] },
    ]);
  });

  it("estimates whether a run can finish before review time", () => {
    const result = estimateSchedule({
      targetWords: 12000,
      tokensPerSecond: 24,
      reviewReadyBy: "07:00",
      now: new Date("2026-05-14T01:00:00-04:00"),
    });

    expect(result.estimatedMinutes).toBeGreaterThan(0);
    expect(result.canFinishByReviewTime).toBe(true);
  });

  it("estimates full-book endurance with retry and overhead reserves", () => {
    const result = estimateBookEndurance({
      targetWords: 45000,
      chapterCount: 8,
      tokensPerSecond: 26,
      reviewReadyBy: "07:00",
      now: new Date("2026-05-14T20:30:00-04:00"),
    });

    expect(result.requiredTokensEstimate).toBeGreaterThan(45000);
    expect(result.estimatedMinutes).toBeGreaterThan(140);
    expect(result.canFinishByReviewTime).toBe(true);
  });
});

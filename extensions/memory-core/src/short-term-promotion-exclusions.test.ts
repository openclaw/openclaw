// Memory Core tests cover how promotion exclusions are counted and explained.
import { describe, expect, it } from "vitest";
import {
  countPromotionExclusions,
  describePromotionExclusion,
  formatZeroPromotionReasons,
} from "./short-term-promotion-exclusions.js";
import type { PromotionExclusion } from "./short-term-promotion-types.js";

function excluded(key: string, reason: PromotionExclusion["reason"]): PromotionExclusion {
  return { key, path: "memory/2026-10-01.md", snippet: key, reason };
}

describe("short-term promotion exclusions", () => {
  it("counts reasons in gate order with at most three sample keys", () => {
    const counts = countPromotionExclusions([
      excluded("q1", "query threshold"),
      ...["o1", "o2", "o3", "o4"].map((key) => excluded(key, "origin")),
    ]);

    expect(counts).toEqual([
      { reason: "origin", count: 4, sampleKeys: ["o1", "o2", "o3"] },
      { reason: "query threshold", count: 1, sampleKeys: ["q1"] },
    ]);
  });

  it("sums ranking and apply reasons for a run that promoted nothing", () => {
    expect(
      formatZeroPromotionReasons(
        [excluded("o1", "origin"), excluded("q1", "query threshold")],
        [{ category: "origin" }, { category: "consolidation origin/session" }],
      ),
    ).toBe("origin 2, query threshold 1, consolidation origin/session 1");
    expect(formatZeroPromotionReasons([], [])).toBe("");
  });

  it("never offers a flag to get past the structural safeguards", () => {
    for (const reason of ["path", "origin", "contamination"] as const) {
      expect(describePromotionExclusion(reason, { minUniqueQueries: 3 })).not.toContain("--");
    }
    expect(describePromotionExclusion("query threshold", { minUniqueQueries: 4 })).toContain(
      "fewer than 4 distinct queries",
    );
  });
});

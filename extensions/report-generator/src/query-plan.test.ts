import { describe, expect, it } from "vitest";
import { DEFAULT_QUERY_PLAN, extractQueryPlan, normalizeQueryPlan } from "./query-plan.js";

describe("normalizeQueryPlan", () => {
  it("accepts a valid plan as-is", () => {
    const plan = normalizeQueryPlan({
      aggregations: ["platform", "emotion", "mediaLevel", "city"],
      topN: { by: "readCount", limit: 5 },
      needDetails: false,
      detailLimit: 30,
    });

    expect(plan).toEqual({
      aggregations: ["platform", "emotion", "mediaLevel", "city"],
      topN: { by: "readCount", limit: 5 },
      needDetails: false,
      detailLimit: 30,
    });
  });

  it("drops hallucinated dimensions and dedupes", () => {
    const plan = normalizeQueryPlan({
      aggregations: ["platform", "platform", "sentiment_score", "author_rank", "day"],
    });

    expect(plan.aggregations).toEqual(["platform", "day"]);
  });

  it("falls back to defaults for an empty or invalid input", () => {
    expect(normalizeQueryPlan(null)).toEqual(DEFAULT_QUERY_PLAN);
    expect(normalizeQueryPlan("not an object")).toEqual(DEFAULT_QUERY_PLAN);
    expect(normalizeQueryPlan({ aggregations: ["bogus"] }).aggregations).toEqual(
      DEFAULT_QUERY_PLAN.aggregations,
    );
  });

  it("rejects unknown metrics and clamps limits", () => {
    const plan = normalizeQueryPlan({
      topN: { by: "DROP TABLE users", limit: 9999 },
      detailLimit: 1,
    });

    expect(plan.topN.by).toBe("fansNumber");
    expect(plan.topN.limit).toBe(20);
    expect(plan.detailLimit).toBe(10);
  });
});

describe("extractQueryPlan", () => {
  it("parses a bare JSON reply", () => {
    const plan = extractQueryPlan(
      '{"aggregations":["emotion"],"topN":{"by":"comments","limit":3}}',
    );

    expect(plan?.aggregations).toEqual(["emotion"]);
    expect(plan?.topN).toEqual({ by: "comments", limit: 3 });
  });

  it("parses JSON wrapped in prose and a code fence", () => {
    const plan = extractQueryPlan(
      '好的，分析模板后我的查询计划如下：\n```json\n{"aggregations":["platform","day"],"needDetails":true}\n```\n希望有帮助。',
    );

    expect(plan?.aggregations).toEqual(["platform", "day"]);
  });

  it("returns null when nothing parses", () => {
    expect(extractQueryPlan("我无法生成查询计划")).toBeNull();
  });
});

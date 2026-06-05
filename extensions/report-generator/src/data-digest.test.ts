import { describe, expect, it } from "vitest";
import { buildDataDigest } from "./data-digest.js";
import type { FeedRecord } from "./types.js";

function record(overrides: Partial<FeedRecord>): FeedRecord {
  return {
    id: 1,
    topicId: 585,
    slaveTopicId: 0,
    platform: "今日头条",
    emotion: "Neutral",
    level: "Blue",
    link: "https://example.com/1",
    date: new Date("2026-05-10T08:00:00Z"),
    fansNumber: 0,
    comments: 0,
    contentType: "Article",
    mediaLevel: "Other",
    city: "广州",
    title: "默认标题",
    author: "默认作者",
    content: "默认正文",
    label: "",
    keywords: "",
    summary: "默认摘要",
    ...overrides,
  };
}

describe("computeDailyAverage", () => {
  it("computes days and average from a 'start ~ end' scope", async () => {
    const { computeDailyAverage } = await import("./data-digest.js");
    const result = computeDailyAverage("2026-05-01 00:00:00 ~ 2026-06-01 00:00:00", 12);
    expect(result).toEqual({ days: 31, dailyAvg: "0.39" });
  });

  it("returns null for an unparseable scope", async () => {
    const { computeDailyAverage } = await import("./data-digest.js");
    expect(computeDailyAverage("invalid", 12)).toBeNull();
    expect(
      computeDailyAverage("2026-06-01 00:00:00 ~ 2026-05-01 00:00:00", 12),
    ).toBeNull();
  });
});

describe("buildDataDigest", () => {
  it("reports an explicit empty marker for zero records", () => {
    expect(buildDataDigest([])).toContain("没有查询到任何舆情数据");
  });

  it("aggregates platform, emotion, level and daily counts over the full set", () => {
    const digest = buildDataDigest([
      record({ id: 1, platform: "微博", emotion: "Negative", level: "Red" }),
      record({ id: 2, platform: "微博", emotion: "Neutral", level: "Blue" }),
      record({ id: 3, platform: "微信", emotion: "Neutral", level: "Blue" }),
    ]);

    expect(digest).toContain("全量 3 条");
    expect(digest).toContain("微博 2 条，微信 1 条");
    expect(digest).toContain("Neutral 2 条，Negative 1 条");
    expect(digest).toContain("负面(Negative)：1 条；高风险(Red/Orange)：1 条");
    expect(digest).toContain("2026-05-10(3)");
  });

  it("highlights high-influence records sorted by fans/comments", () => {
    const digest = buildDataDigest([
      record({ id: 1, title: "小号发文", fansNumber: 10 }),
      record({ id: 2, title: "大V爆料", fansNumber: 50000, comments: 200 }),
    ]);

    const influenceSection = digest.split("### 高影响力条目")[1];
    expect(influenceSection).toBeDefined();
    expect(influenceSection.indexOf("大V爆料")).toBeLessThan(influenceSection.indexOf("小号发文"));
    expect(influenceSection).toContain("粉丝:50000");
  });

  it("lists record details with truncated excerpts", () => {
    const digest = buildDataDigest([
      record({ id: 1, title: "员工爆料裁员", summary: "长".repeat(300) }),
    ]);

    expect(digest).toContain("员工爆料裁员");
    expect(digest).toContain("…");
    expect(digest).not.toContain("长".repeat(200));
  });

  it("caps the detail list at 50 records while aggregating all of them", () => {
    const records = Array.from({ length: 60 }, (_, i) =>
      record({ id: i + 1, title: `条目${i + 1}` }),
    );

    const digest = buildDataDigest(records);

    expect(digest).toContain("全量 60 条");
    expect(digest).toContain("前 50 条，共 60 条");
    expect(digest).toContain("条目50");
    expect(digest).not.toContain("条目51");
  });
});

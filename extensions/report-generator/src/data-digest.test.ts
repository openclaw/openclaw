import { describe, expect, it } from "vitest";
import { buildStatsDigest, computeDailyAverage } from "./data-digest.js";
import type { CollectedStats, TopRecord } from "./query-plan.js";
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

function topRecord(overrides: Partial<TopRecord>): TopRecord {
  return { ...record({}), metricValue: 0, ...overrides };
}

function stats(overrides: Partial<CollectedStats>): CollectedStats {
  return {
    total: 0,
    aggregations: [],
    topN: { metric: "fansNumber", records: [] },
    details: [],
    ...overrides,
  };
}

describe("computeDailyAverage", () => {
  it("computes days and average from a 'start ~ end' scope", () => {
    const result = computeDailyAverage("2026-05-01 00:00:00 ~ 2026-06-01 00:00:00", 12);
    expect(result).toEqual({ days: 31, dailyAvg: "0.39" });
  });

  it("returns null for an unparseable scope", () => {
    expect(computeDailyAverage("invalid", 12)).toBeNull();
    expect(computeDailyAverage("2026-06-01 00:00:00 ~ 2026-05-01 00:00:00", 12)).toBeNull();
  });
});

describe("buildStatsDigest", () => {
  it("reports an explicit empty marker for zero records", () => {
    expect(buildStatsDigest(stats({ total: 0 }))).toContain("没有查询到任何舆情数据");
  });

  it("renders full-set aggregations with Chinese labels", () => {
    const digest = buildStatsDigest(
      stats({
        total: 1200,
        aggregations: [
          {
            dimension: "platform",
            buckets: [
              { key: "微博", count: 800 },
              { key: "微信", count: 400 },
            ],
          },
          {
            dimension: "day",
            buckets: [
              { key: "2026-05-01", count: 700 },
              { key: "2026-05-02", count: 500 },
            ],
          },
        ],
      }),
    );

    expect(digest).toContain("共 1200 条");
    expect(digest).toContain("平台分布：微博 800 条，微信 400 条");
    expect(digest).toContain("每日走势：2026-05-01(700)，2026-05-02(500)");
  });

  it("renders the author and label aggregation labels", () => {
    const digest = buildStatsDigest(
      stats({
        total: 5,
        aggregations: [
          {
            dimension: "author",
            buckets: [
              { key: "@张三", count: 3 },
              { key: "@李四", count: 2 },
            ],
          },
          { dimension: "label", buckets: [{ key: "拖欠工资", count: 4 }] },
        ],
      }),
    );

    expect(digest).toContain("作者/账号分布：@张三 3 条，@李四 2 条");
    expect(digest).toContain("事件标签分布：拖欠工资 4 条");
  });

  it("includes the source link in high-influence and detail items", () => {
    const digest = buildStatsDigest(
      stats({
        total: 1,
        topN: {
          metric: "fansNumber",
          records: [
            topRecord({ title: "指控拖欠", link: "https://weibo.com/x", metricValue: 100 }),
          ],
        },
        details: [record({ title: "考勤表质疑", link: "https://weibo.com/y" })],
      }),
    );

    expect(digest).toContain("链接:https://weibo.com/x");
    expect(digest).toContain("链接:https://weibo.com/y");
  });

  it("derives negative and high-risk counts from emotion/level buckets", () => {
    const digest = buildStatsDigest(
      stats({
        total: 10,
        aggregations: [
          {
            dimension: "emotion",
            buckets: [
              { key: "Neutral", count: 7 },
              { key: "Negative", count: 3 },
            ],
          },
          {
            dimension: "level",
            buckets: [
              { key: "Blue", count: 8 },
              { key: "Red", count: 1 },
              { key: "Orange", count: 1 },
            ],
          },
        ],
      }),
    );

    expect(digest).toContain("负面(Negative)：3 条；高风险(Red/Orange)：2 条");
  });

  it("renders top-N records with the ranking metric", () => {
    const digest = buildStatsDigest(
      stats({
        total: 100,
        topN: {
          metric: "readCount",
          records: [topRecord({ title: "爆款文章", metricValue: 98765 })],
        },
      }),
    );

    expect(digest).toContain("高影响力条目（按阅读量排序，前 1 条）");
    expect(digest).toContain("爆款文章");
    expect(digest).toContain("阅读量:98765");
  });

  it("labels a capped detail list against the full total", () => {
    const digest = buildStatsDigest(
      stats({
        total: 800,
        details: [record({ title: "员工爆料裁员", summary: "长".repeat(300) })],
      }),
    );

    expect(digest).toContain("前 1 条，全量共 800 条");
    expect(digest).toContain("员工爆料裁员");
    // Excerpts are truncated for prompt size.
    expect(digest).toContain("…");
    expect(digest).not.toContain("长".repeat(200));
  });
});

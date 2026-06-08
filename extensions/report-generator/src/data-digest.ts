import type { CollectedStats, AggregationResult } from "./query-plan.js";
import type { FeedRecord } from "./types.js";

/** Max chars of summary/content excerpt per detailed record. */
const EXCERPT_LIMIT = 120;

const DIMENSION_LABELS: Record<string, string> = {
  platform: "平台分布",
  emotion: "情感分布",
  level: "风险级别分布",
  mediaLevel: "媒体级别分布",
  city: "城市分布",
  contentType: "内容类型分布",
  day: "每日走势",
  author: "作者/账号分布",
  label: "事件标签分布",
};

const METRIC_LABELS: Record<string, string> = {
  fansNumber: "粉丝量",
  readCount: "阅读量",
  comments: "评论量",
  forwardNumber: "转发量",
  praiseNum: "点赞量",
  topicInteractionCount: "互动量",
};

function formatDate(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    return String(date);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function excerpt(record: FeedRecord): string {
  const source = (record.summary || record.content || "").replace(/\s+/g, " ").trim();
  if (!source) {
    return "";
  }
  return source.length > EXCERPT_LIMIT ? `${source.slice(0, EXCERPT_LIMIT)}…` : source;
}

function detailLine(record: FeedRecord, index: number, metricSuffix = ""): string {
  const parts = [
    `${index + 1}. [${record.platform || "未知"}] ${record.title || "（无标题）"}`,
    formatDate(record.date),
    `情感:${record.emotion || "未知"}`,
    `级别:${record.level || "未知"}`,
  ];
  if (record.fansNumber > 0) {
    parts.push(`粉丝:${record.fansNumber}`);
  }
  if (record.comments > 0) {
    parts.push(`评论:${record.comments}`);
  }
  if (record.author) {
    parts.push(`作者:${record.author}`);
  }
  if (metricSuffix) {
    parts.push(metricSuffix);
  }
  // Source URL so the report can cite "相关链接". Without it in the digest the
  // writer LLM has no URL and (under the no-fabrication rule) omits links.
  if (record.link) {
    parts.push(`链接:${record.link}`);
  }
  const head = parts.join(" | ");
  const body = excerpt(record);
  return body ? `${head}\n   摘要: ${body}` : head;
}

function aggregationLine(agg: AggregationResult): string {
  const label = DIMENSION_LABELS[agg.dimension] ?? agg.dimension;
  if (agg.buckets.length === 0) {
    return `- ${label}：暂无数据`;
  }
  const rendered =
    agg.dimension === "day"
      ? agg.buckets.map((b) => `${b.key}(${b.count})`).join("，")
      : agg.buckets.map((b) => `${b.key} ${b.count} 条`).join("，");
  return `- ${label}：${rendered}`;
}

function bucketCount(stats: CollectedStats, dimension: string, keys: string[]): number | null {
  const agg = stats.aggregations.find((a) => a.dimension === dimension);
  if (!agg) {
    return null;
  }
  return agg.buckets.filter((b) => keys.includes(b.key)).reduce((sum, b) => sum + b.count, 0);
}

/**
 * Compute the day count and daily average for a "start ~ end" dateScope.
 * Returns null when the scope cannot be parsed — callers omit the line.
 * Feeds template placeholders like {dailyAvg} with exact, code-computed
 * numbers instead of model arithmetic.
 */
export function computeDailyAverage(
  dateScope: string,
  totalCount: number,
): { days: number; dailyAvg: string } | null {
  const [startRaw, endRaw] = dateScope.split("~").map((s) => s.trim());
  if (!startRaw || !endRaw) {
    return null;
  }
  const start = new Date(startRaw.replace(" ", "T"));
  const end = new Date(endRaw.replace(" ", "T"));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return null;
  }
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000));
  return { days, dailyAvg: (totalCount / days).toFixed(2) };
}

/**
 * Render code-collected, full-set statistics (CollectedStats from
 * FeedCollector.collectStats — aggregations pushed down to SQL, never
 * capped by a fetch limit) into a structured digest for the report prompt.
 * The agent writes prose from this digest and never needs (nor has)
 * database access — keeping report numbers grounded in the actual data
 * instead of model guesses.
 */
export function buildStatsDigest(stats: CollectedStats): string {
  if (stats.total === 0) {
    return "该时间范围内没有查询到任何舆情数据（已按专题与日期过滤、排除 skip=1）。";
  }

  const sections = [
    `### 统计概览（SQL 全量聚合，共 ${stats.total} 条）`,
    ...stats.aggregations.map(aggregationLine),
  ];

  const negatives = bucketCount(stats, "emotion", ["Negative"]);
  const highRisk = bucketCount(stats, "level", ["Red", "Orange"]);
  if (negatives !== null || highRisk !== null) {
    const parts = [];
    if (negatives !== null) {
      parts.push(`负面(Negative)：${negatives} 条`);
    }
    if (highRisk !== null) {
      parts.push(`高风险(Red/Orange)：${highRisk} 条`);
    }
    sections.push(`- ${parts.join("；")}`);
  }

  if (stats.topN.records.length > 0) {
    const metricLabel = METRIC_LABELS[stats.topN.metric] ?? stats.topN.metric;
    sections.push(
      "",
      `### 高影响力条目（按${metricLabel}排序，前 ${stats.topN.records.length} 条）`,
      ...stats.topN.records.map((r, i) => detailLine(r, i, `${metricLabel}:${r.metricValue}`)),
    );
  }

  if (stats.details.length > 0) {
    sections.push(
      "",
      stats.total > stats.details.length
        ? `### 条目明细（按时间倒序，前 ${stats.details.length} 条，全量共 ${stats.total} 条）`
        : `### 条目明细（按时间倒序，共 ${stats.details.length} 条）`,
      ...stats.details.map((r, i) => detailLine(r, i)),
    );
  }

  return sections.join("\n");
}

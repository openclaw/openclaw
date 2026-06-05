import type { FeedRecord } from "./types.js";

/** Max records listed in detail; aggregates always cover the full set. */
const DETAIL_LIMIT = 50;
/** Max chars of summary/content excerpt per detailed record. */
const EXCERPT_LIMIT = 120;
/** Top-N high-influence records highlighted separately. */
const TOP_INFLUENCE_LIMIT = 10;

function formatDate(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    return String(date);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function countBy(records: FeedRecord[], key: (r: FeedRecord) => string): [string, number][] {
  const counts = new Map<string, number>();
  for (const r of records) {
    const k = key(r) || "未知";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].toSorted((a, b) => b[1] - a[1]);
}

function distributionLine(entries: [string, number][]): string {
  return entries.map(([k, v]) => `${k} ${v} 条`).join("，");
}

function excerpt(record: FeedRecord): string {
  const source = (record.summary || record.content || "").replace(/\s+/g, " ").trim();
  if (!source) {
    return "";
  }
  return source.length > EXCERPT_LIMIT ? `${source.slice(0, EXCERPT_LIMIT)}…` : source;
}

function influenceScore(record: FeedRecord): number {
  return (record.fansNumber || 0) + (record.comments || 0) * 10;
}

function detailLine(record: FeedRecord, index: number): string {
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
  const head = parts.join(" | ");
  const body = excerpt(record);
  return body ? `${head}\n   摘要: ${body}` : head;
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
 * Render the REAL query results (collected by FeedCollector from
 * feed_monitor_item) into a structured digest for the report prompt:
 * full-set aggregates + daily trend + top-influence highlights + a capped
 * detail list. The agent writes prose from this digest and never needs
 * (nor has) database access — keeping report numbers grounded in the
 * actual data instead of model guesses.
 */
export function buildDataDigest(records: FeedRecord[]): string {
  if (records.length === 0) {
    return "该时间范围内没有查询到任何舆情数据（已按专题与日期过滤、排除 skip=1）。";
  }

  const byPlatform = countBy(records, (r) => r.platform);
  const byEmotion = countBy(records, (r) => r.emotion);
  const byLevel = countBy(records, (r) => r.level);
  const byDay = countBy(records, (r) => formatDate(r.date)).toSorted((a, b) =>
    a[0].localeCompare(b[0]),
  );

  const negatives = records.filter((r) => r.emotion === "Negative");
  const highRisk = records.filter((r) => r.level === "Red" || r.level === "Orange");

  const topInfluence = records
    .filter((r) => influenceScore(r) > 0)
    .toSorted((a, b) => influenceScore(b) - influenceScore(a))
    .slice(0, TOP_INFLUENCE_LIMIT);

  const detailed = records.slice(0, DETAIL_LIMIT);

  const sections = [
    `### 统计概览（全量 ${records.length} 条）`,
    `- 平台分布：${distributionLine(byPlatform)}`,
    `- 情感分布：${distributionLine(byEmotion)}`,
    `- 风险级别分布：${distributionLine(byLevel)}`,
    `- 负面(Negative)：${negatives.length} 条；高风险(Red/Orange)：${highRisk.length} 条`,
    `- 每日走势：${byDay.map(([d, c]) => `${d}(${c})`).join("，")}`,
  ];

  if (topInfluence.length > 0) {
    sections.push(
      "",
      "### 高影响力条目（按粉丝量/评论量排序）",
      ...topInfluence.map((r, i) => detailLine(r, i)),
    );
  }

  sections.push(
    "",
    records.length > DETAIL_LIMIT
      ? `### 条目明细（按时间倒序，前 ${DETAIL_LIMIT} 条，共 ${records.length} 条）`
      : `### 条目明细（按时间倒序，共 ${records.length} 条）`,
    ...detailed.map((r, i) => detailLine(r, i)),
  );

  return sections.join("\n");
}

import type { FeedRecord } from "./types.js";

/**
 * LLM-planned, code-executed report data queries.
 *
 * The LLM reads the report template and proposes WHAT to aggregate as a
 * structured plan (never SQL). Code validates every field against the
 * whitelists below and builds parameterized SQL itself, so a hallucinated
 * dimension degrades to the default plan instead of a broken or unsafe
 * query. Credentials never leave the gateway.
 */
export interface QueryPlan {
  /** Dimensions to GROUP BY over the FULL filtered set (no row cap). */
  aggregations: string[];
  /** Top-N records by a metric column, for "high influence" sections. */
  topN: { by: string; limit: number };
  /** Whether to include a recent-record detail list in the prompt. */
  needDetails: boolean;
  /** Detail list length (prompt-size cap, not a statistics cap). */
  detailLimit: number;
}

/** dimension name -> safe SQL expression (feed_monitor_item alias f). */
export const AGGREGATION_DIMENSIONS: Record<string, string> = {
  platform: "f.platform",
  emotion: "f.emotion",
  level: "f.level",
  mediaLevel: "f.mediaLevel",
  city: "f.city",
  contentType: "f.contentType",
  day: "DATE(f.date)",
};

/** metric name -> safe SQL expression for top-N ordering. */
export const TOPN_METRICS: Record<string, string> = {
  fansNumber: "f.fansNumber",
  readCount: "f.readCount",
  comments: "f.comments",
  forwardNumber: "f.forwardNumber",
  praiseNum: "f.praiseNum",
  topicInteractionCount: "f.topicInteractionCount",
};

export const DEFAULT_QUERY_PLAN: QueryPlan = {
  aggregations: ["platform", "emotion", "level", "day"],
  topN: { by: "fansNumber", limit: 10 },
  needDetails: true,
  detailLimit: 50,
};

const TOPN_LIMIT_MAX = 20;
const DETAIL_LIMIT_MAX = 100;

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Validate an LLM-proposed plan against the whitelists. Unknown dimensions
 * and metrics are dropped (not errors — the model may guess); an empty or
 * unusable plan falls back to DEFAULT_QUERY_PLAN fields.
 */
export function normalizeQueryPlan(raw: unknown): QueryPlan {
  if (!raw || typeof raw !== "object") {
    return DEFAULT_QUERY_PLAN;
  }
  const input = raw as {
    aggregations?: unknown;
    topN?: { by?: unknown; limit?: unknown };
    needDetails?: unknown;
    detailLimit?: unknown;
  };

  const aggregations = Array.isArray(input.aggregations)
    ? [...new Set(input.aggregations.filter((d): d is string => typeof d === "string"))].filter(
        (d) => d in AGGREGATION_DIMENSIONS,
      )
    : [];

  const topNBy =
    typeof input.topN?.by === "string" && input.topN.by in TOPN_METRICS
      ? input.topN.by
      : DEFAULT_QUERY_PLAN.topN.by;

  return {
    aggregations: aggregations.length > 0 ? aggregations : DEFAULT_QUERY_PLAN.aggregations,
    topN: {
      by: topNBy,
      limit: clamp(Number(input.topN?.limit), 1, TOPN_LIMIT_MAX, DEFAULT_QUERY_PLAN.topN.limit),
    },
    needDetails:
      typeof input.needDetails === "boolean" ? input.needDetails : DEFAULT_QUERY_PLAN.needDetails,
    detailLimit: clamp(
      Number(input.detailLimit),
      10,
      DETAIL_LIMIT_MAX,
      DEFAULT_QUERY_PLAN.detailLimit,
    ),
  };
}

/**
 * Pull the first JSON object out of an LLM reply (which may wrap it in
 * prose or a ```json fence). Returns null when nothing parses.
 */
export function extractQueryPlan(text: string): QueryPlan | null {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    candidates.push(fenced[1]);
  }
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) {
    candidates.push(brace[0]);
  }
  for (const candidate of candidates) {
    try {
      return normalizeQueryPlan(JSON.parse(candidate));
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Prompt for the planning step: template in, strict JSON out. */
export function buildPlanPrompt(template: string): string {
  return `你是舆情报告系统的数据规划模块。阅读下方报告模板，判断填写模板需要哪些统计数据，输出一个 JSON 查询计划。

## 可用的统计维度（aggregations，按需选择）
- platform：平台分布
- emotion：情感分布（Positive/Neutral/Negative）
- level：风险级别分布（Red/Orange/Yellow/Blue）
- mediaLevel：媒体级别分布
- city：城市分布
- contentType：内容类型分布（Article/Video/Comment）
- day：每日数据量走势

## 可用的排序指标（topN.by，选一个）
fansNumber（粉丝量）、readCount（阅读量）、comments（评论量）、forwardNumber（转发量）、praiseNum（点赞量）、topicInteractionCount（互动量）

## 报告模板
${template}

## 输出要求
只输出一个 JSON 对象，不要任何其他文字，格式：
{"aggregations":["platform","emotion","level","day"],"topN":{"by":"fansNumber","limit":10},"needDetails":true,"detailLimit":50}`;
}

/** One GROUP BY bucket from a full-set aggregation query. */
export interface AggregationBucket {
  key: string;
  count: number;
}

export interface AggregationResult {
  dimension: string;
  buckets: AggregationBucket[];
}

/** A top-N record with the metric it was ranked by. */
export interface TopRecord extends FeedRecord {
  metricValue: number;
}

/** Full-set statistics collected by code according to a QueryPlan. */
export interface CollectedStats {
  /** COUNT(*) over the whole filtered set — not capped by any row limit. */
  total: number;
  aggregations: AggregationResult[];
  topN: { metric: string; records: TopRecord[] };
  /** Recent records for the detail list (prompt-size cap only). */
  details: FeedRecord[];
}

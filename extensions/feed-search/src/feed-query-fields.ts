/**
 * Whitelists for the feed_query tool. Every identifier that can reach SQL
 * text lives here; user/LLM input only ever binds as parameter values.
 * Declaration order is the deterministic output order (prompt-cache safe).
 */

/** Risk levels accepted as filters (feed_monitor_item.level enum). */
export const LEVELS = ["Red", "Orange", "Yellow", "Blue"] as const;

/** Sentiment values accepted as filters (feed_monitor_item.emotion enum). */
export const EMOTIONS = ["Positive", "Neutral", "Negative"] as const;

/**
 * dimension name -> safe SQL expression for stats GROUP BY.
 * Mirrors extensions/report-generator/src/query-plan.ts.
 */
export const AGGREGATION_DIMENSIONS: Record<string, string> = {
  platform: "f.platform",
  emotion: "f.emotion",
  level: "f.level",
  mediaLevel: "f.mediaLevel",
  city: "f.city",
  contentType: "f.contentType",
  day: "DATE(f.date)",
};

/** Dimensions used when the agent omits groupBy in stats mode. */
export const DEFAULT_STATS_DIMENSIONS = ["level", "emotion", "platform", "day"] as const;

/**
 * Columns returned by search mode, in deterministic order. This is the
 * visible-field whitelist: internal pipeline flags (skip/pushed/vectored/...)
 * and the raw result JSON never leave the database.
 */
export const SEARCH_COLUMNS = [
  "f.id",
  "d.title",
  "d.summary",
  "d.author",
  "f.platform",
  "f.level",
  "f.emotion",
  "f.date",
  "f.link",
  "f.mediaLevel",
  "f.contentType",
  "f.city",
  "f.readCount",
  "f.comments",
  "f.forwardNumber",
  "f.praiseNum",
] as const;

export const SEARCH_LIMIT_MAX = 500;
export const SEARCH_LIMIT_DEFAULT = 20;

/** Max buckets returned per stats dimension. */
export const STATS_BUCKET_MAX = 30;

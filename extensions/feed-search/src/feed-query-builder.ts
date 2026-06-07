import type { AuthorizedTopic } from "./auth-topic-resolver.js";
import {
  AGGREGATION_DIMENSIONS,
  DEFAULT_STATS_DIMENSIONS,
  EMOTIONS,
  LEVELS,
  SEARCH_COLUMNS,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  STATS_BUCKET_MAX,
} from "./feed-query-fields.js";

/**
 * Structured filters accepted by the feed_query tool. All values bind as SQL
 * parameters; identifiers (columns, dimensions) only come from whitelists.
 */
export interface FeedQueryFilters {
  topicId?: number;
  /** YYYY-MM-DD, inclusive lower bound. */
  startDate?: string;
  /** YYYY-MM-DD, inclusive upper bound. */
  endDate?: string;
  level?: string[];
  emotion?: string[];
  platform?: string;
  keyword?: string;
  limit?: number;
  groupBy?: string[];
}

export interface BuiltQuery {
  sql: string;
  values: Array<string | number>;
}

/** Thrown when the requested topicId is not in the user's authorized set. */
export class UnauthorizedTopicError extends Error {
  readonly authorizedTopics: AuthorizedTopic[];

  constructor(requested: number | undefined, authorizedTopics: AuthorizedTopic[]) {
    super(
      requested === undefined
        ? "no authorized topics for this user"
        : `topic ${requested} is not authorized for this user`,
    );
    this.name = "UnauthorizedTopicError";
    this.authorizedTopics = authorizedTopics;
  }
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  const int = Math.trunc(value);
  if (int < min) {
    // Intentional: 0/negative means "unspecified" and takes the default
    // rather than snapping to min.
    return int <= 0 ? fallback : min;
  }
  return Math.min(int, max);
}

/** Escape LIKE wildcards so keywords match literally. */
function escapeLike(keyword: string): string {
  return keyword.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function assertDate(value: string, label: string): void {
  if (!DATE_PATTERN.test(value)) {
    throw new Error(`${label} must be a date in YYYY-MM-DD format, got: ${JSON.stringify(value)}`);
  }
}

/**
 * Pick the target topic: omitted topicId falls back to the primary (most
 * recently granted) topic; an explicit topicId must be in the authorized set.
 */
export function selectTargetTopic(
  requestedTopicId: number | undefined,
  authorizedTopics: AuthorizedTopic[],
): AuthorizedTopic {
  if (authorizedTopics.length === 0) {
    throw new UnauthorizedTopicError(requestedTopicId, authorizedTopics);
  }
  if (requestedTopicId === undefined) {
    return authorizedTopics[0];
  }
  const match = authorizedTopics.find((t) => t.topicId === requestedTopicId);
  if (!match) {
    throw new UnauthorizedTopicError(requestedTopicId, authorizedTopics);
  }
  return match;
}

interface WhereClause {
  conditions: string[];
  values: Array<string | number>;
  needsDataJoin: boolean;
}

/**
 * Shared WHERE builder. The topic condition and skip = 0 are always present
 * and always come first; everything else is optional and parameterized.
 */
function buildWhere(filters: FeedQueryFilters, topic: AuthorizedTopic): WhereClause {
  const topicColumn = topic.useSlaveTopic ? "f.slaveTopicId" : "f.topicId";
  const conditions: string[] = [`${topicColumn} = ?`, "f.skip = 0"];
  const values: Array<string | number> = [topic.topicId];
  let needsDataJoin = false;

  if (filters.startDate !== undefined) {
    assertDate(filters.startDate, "startDate");
    conditions.push("f.date >= ?");
    values.push(filters.startDate);
  }
  if (filters.endDate !== undefined) {
    assertDate(filters.endDate, "endDate");
    conditions.push("f.date < DATE_ADD(?, INTERVAL 1 DAY)");
    values.push(filters.endDate);
  }

  const levels = (filters.level ?? []).filter((v) => (LEVELS as readonly string[]).includes(v));
  if (levels.length > 0) {
    conditions.push(`f.level IN (${levels.map(() => "?").join(",")})`);
    values.push(...levels);
  }

  const emotions = (filters.emotion ?? []).filter((v) =>
    (EMOTIONS as readonly string[]).includes(v),
  );
  if (emotions.length > 0) {
    conditions.push(`f.emotion IN (${emotions.map(() => "?").join(",")})`);
    values.push(...emotions);
  }

  if (filters.platform) {
    conditions.push("f.platform = ?");
    values.push(filters.platform);
  }

  if (filters.keyword) {
    const pattern = `%${escapeLike(filters.keyword)}%`;
    // Explicit ESCAPE so the escaping above never depends on the server's
    // default LIKE escape character.
    conditions.push(
      "(d.title LIKE ? ESCAPE '\\\\' OR d.summary LIKE ? ESCAPE '\\\\' OR d.content LIKE ? ESCAPE '\\\\')",
    );
    values.push(pattern, pattern, pattern);
    needsDataJoin = true;
  }

  return { conditions, values, needsDataJoin };
}

/** Build the parameterized detail-search query (always joins the data table). */
export function buildSearchQuery(
  filters: FeedQueryFilters,
  authorizedTopics: AuthorizedTopic[],
): BuiltQuery & { topic: AuthorizedTopic } {
  const topic = selectTargetTopic(filters.topicId, authorizedTopics);
  const where = buildWhere(filters, topic);
  const limit = clamp(filters.limit, 1, SEARCH_LIMIT_MAX, SEARCH_LIMIT_DEFAULT);

  const sql =
    `SELECT ${SEARCH_COLUMNS.join(", ")} ` +
    "FROM feed_monitor_item f JOIN feed_monitor_item_data d ON d.id = f.id " +
    `WHERE ${where.conditions.join(" AND ")} ` +
    // limit is a server-clamped integer, never raw input (mysql2 execute()
    // does not accept LIMIT as a bound parameter).
    `ORDER BY f.date DESC, f.id DESC LIMIT ${limit}`;

  return { sql, values: where.values, topic };
}

export interface StatsDimensionQuery extends BuiltQuery {
  dimension: string;
}

export interface StatsQueries {
  topic: AuthorizedTopic;
  totalQuery: BuiltQuery;
  dimensionQueries: StatsDimensionQuery[];
}

/**
 * Build the stats queries: one COUNT(*) total plus one GROUP BY query per
 * whitelisted dimension. Dimension SQL expressions come exclusively from
 * AGGREGATION_DIMENSIONS; only values are bound as parameters.
 */
export function buildStatsQueries(
  filters: FeedQueryFilters,
  authorizedTopics: AuthorizedTopic[],
): StatsQueries {
  const topic = selectTargetTopic(filters.topicId, authorizedTopics);
  const where = buildWhere(filters, topic);

  const requested = (filters.groupBy ?? []).filter((d) => d in AGGREGATION_DIMENSIONS);
  const dimensions = requested.length > 0 ? requested : [...DEFAULT_STATS_DIMENSIONS];

  const join = where.needsDataJoin ? " JOIN feed_monitor_item_data d ON d.id = f.id" : "";
  const whereSql = `WHERE ${where.conditions.join(" AND ")}`;

  const totalQuery: BuiltQuery = {
    sql: `SELECT COUNT(*) AS cnt FROM feed_monitor_item f${join} ${whereSql}`,
    values: where.values,
  };

  const dimensionQueries = dimensions.map((dimension) => {
    const expr = AGGREGATION_DIMENSIONS[dimension];
    return {
      dimension,
      sql:
        `SELECT ${expr} AS value, COUNT(*) AS cnt FROM feed_monitor_item f${join} ` +
        `${whereSql} GROUP BY ${expr} ORDER BY cnt DESC, value ASC LIMIT ${STATS_BUCKET_MAX}`,
      values: where.values,
    };
  });

  return { topic, totalQuery, dimensionQueries };
}

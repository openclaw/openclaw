import mysql from "mysql2/promise";
import type { PluginLogger } from "../api.js";
import {
  AGGREGATION_DIMENSIONS,
  DATA_JOIN_DIMENSIONS,
  TOPN_METRICS,
  type AggregationResult,
  type CollectedStats,
  type QueryPlan,
  type TopRecord,
} from "./query-plan.js";
import type { HistoryDbConfig, FeedRecord } from "./types.js";

function formatDayKey(value: unknown): string {
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) {
    return String(value);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export class FeedCollector {
  private readonly config: HistoryDbConfig;
  private pool: mysql.Pool | null = null;

  constructor(historyDbConfig: HistoryDbConfig) {
    this.config = historyDbConfig;
  }

  private async getPool(): Promise<mysql.Pool> {
    if (!this.pool) {
      this.pool = mysql.createPool({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        connectionLimit: 3,
        waitForConnections: true,
        charset: "utf8mb4",
        timezone: "+08:00",
      });
    }
    return this.pool;
  }

  /**
   * Execute a validated QueryPlan with aggregations pushed down to SQL, so
   * statistics cover the FULL filtered set (no row cap — the old approach
   * aggregated over at most 500 fetched rows). Dimension/metric SQL
   * expressions come exclusively from the query-plan whitelists; only
   * values are bound as parameters.
   */
  async collectStats(
    topicId: number,
    slaveTopicId: number,
    startDate: string,
    endDate: string,
    plan: QueryPlan,
    logger: PluginLogger,
  ): Promise<CollectedStats> {
    const pool = await this.getPool();
    const useSlaveTopic = slaveTopicId > 0;
    const topicField = useSlaveTopic ? "f.slaveTopicId" : "f.topicId";
    const matchValue = useSlaveTopic ? slaveTopicId : topicId;
    const where = `WHERE ${topicField} = ? AND f.date >= ? AND f.date < ? AND f.skip = 0`;
    const params = [matchValue, startDate, endDate];
    const startTime = Date.now();

    const [totalRows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM feed_monitor_item f ${where}`,
      params,
    );
    const total = Number(totalRows?.[0]?.cnt) || 0;

    const aggregations: AggregationResult[] = [];
    for (const dimension of plan.aggregations) {
      const expr = AGGREGATION_DIMENSIONS[dimension];
      if (!expr) {
        continue; // defensive: plan is pre-validated upstream
      }
      // author/label live in feed_monitor_item_data — JOIN only when needed so
      // the common f-only dimensions keep their lighter single-table query.
      const join = DATA_JOIN_DIMENSIONS.has(dimension)
        ? "JOIN feed_monitor_item_data d ON f.id = d.id"
        : "";
      const order = dimension === "day" ? "k ASC" : "cnt DESC";
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT ${expr} AS k, COUNT(*) AS cnt FROM feed_monitor_item f ${join} ${where} GROUP BY k ORDER BY ${order} LIMIT 100`,
        params,
      );
      aggregations.push({
        dimension,
        buckets: (rows ?? []).map((r) => ({
          key: dimension === "day" ? formatDayKey(r.k) : String(r.k ?? "未知"),
          count: Number(r.cnt) || 0,
        })),
      });
    }

    const metricExpr = TOPN_METRICS[plan.topN.by] ?? TOPN_METRICS.fansNumber;
    // limit values are clamped integers from normalizeQueryPlan — safe to inline
    // (mysql2 prepared statements reject LIMIT placeholders on some servers).
    const [topRows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT f.id, f.topicId, f.slaveTopicId, f.platform, f.emotion, f.level,
              f.link, f.date, f.fansNumber, f.comments, f.contentType,
              f.mediaLevel, f.city, ${metricExpr} AS metricValue,
              d.title, d.author, d.summary
       FROM feed_monitor_item f
       JOIN feed_monitor_item_data d ON f.id = d.id
       ${where} AND ${metricExpr} > 0
       ORDER BY metricValue DESC
       LIMIT ${plan.topN.limit}`,
      params,
    );

    const details = plan.needDetails
      ? await this.collectDetailRows(pool, where, params, plan.detailLimit)
      : [];

    logger.info(
      `[FEED_COLLECTOR] Stats collected in ${Date.now() - startTime}ms ` +
        `(total=${total}, dims=[${plan.aggregations.join(",")}], topN=${plan.topN.by}x${plan.topN.limit}, ` +
        `details=${details.length}, topicId=${topicId}, slaveTopicId=${slaveTopicId})`,
    );

    return {
      total,
      aggregations,
      topN: { metric: plan.topN.by, records: topRows as unknown as TopRecord[] },
      details,
    };
  }

  private async collectDetailRows(
    pool: mysql.Pool,
    where: string,
    params: (number | string)[],
    limit: number,
  ): Promise<FeedRecord[]> {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT f.id, f.topicId, f.slaveTopicId, f.platform, f.emotion, f.level,
              f.link, f.date, f.fansNumber, f.comments, f.contentType,
              f.mediaLevel, f.city,
              d.title, d.author, d.content, d.label, d.keywords, d.summary
       FROM feed_monitor_item f
       JOIN feed_monitor_item_data d ON f.id = d.id
       ${where}
       ORDER BY f.date DESC
       LIMIT ${limit}`,
      params,
    );
    return rows as unknown as FeedRecord[];
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

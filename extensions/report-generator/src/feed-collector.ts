import mysql from "mysql2/promise";
import type { PluginLogger } from "../api.js";
import type { HistoryDbConfig, FeedRecord } from "./types.js";

/** SLAVE_TOPIC_RANGE - same logic as topic-resolver */
const SLAVE_TOPIC_RANGE = new Set(
  Array.from({ length: 22 }, (_, i) => 328 + i), // 328-349
);

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
   * Collect feed data by topicId and date range.
   * If topicId is in 328-349 range, use slaveTopicId for matching.
   */
  async collectFeedData(
    topicId: number,
    startDate: string,
    endDate: string,
    logger: PluginLogger,
  ): Promise<FeedRecord[]> {
    const pool = await this.getPool();
    const useSlaveTopic = SLAVE_TOPIC_RANGE.has(topicId);
    const topicField = useSlaveTopic ? "f.slaveTopicId" : "f.topicId";

    const sql = `
      SELECT f.id, f.topicId, f.slaveTopicId, f.platform, f.emotion, f.level,
             f.link, f.date, f.fansNumber, f.comments, f.contentType,
             f.mediaLevel, f.city,
             d.title, d.author, d.content, d.label, d.keywords, d.summary
      FROM feed_monitor_item f
      JOIN feed_monitor_item_data d ON f.id = d.id
      WHERE ${topicField} = ?
        AND f.date >= ?
        AND f.date < ?
        AND f.skip = 0
      ORDER BY f.date DESC
      LIMIT 500
    `;

    try {
      const startTime = Date.now();
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(sql, [topicId, startDate, endDate]);
      const durationMs = Date.now() - startTime;
      logger.info(
        `[FEED_COLLECTOR] Collected ${rows.length} records in ${durationMs}ms ` +
          `(topicId=${topicId}, useSlaveTopic=${useSlaveTopic})`,
      );
      return rows as unknown as FeedRecord[];
    } catch (error) {
      logger.error(`[FEED_COLLECTOR] Query failed: ${String(error)}`);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

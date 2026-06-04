import mysql from "mysql2/promise";
import type { HistoryDbConfig } from "./types.js";

/** TopicIds in range 328-349 match against slaveTopicId (mirrors topic-resolver). */
const SLAVE_TOPIC_RANGE = new Set(
  Array.from({ length: 22 }, (_, i) => 328 + i), // 328-349
);

/**
 * Counts available feed records for a topic + date range. Used to give the user
 * an up-front data-volume hint (and catch the empty case) before a report task
 * is queued for asynchronous generation by the report-generator service.
 *
 * Reads the same tables and applies the same filter as the report generator's
 * FeedCollector, so the count reflects what the report will actually use.
 */
export class FeedCounter {
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
        connectionLimit: 2,
        waitForConnections: true,
        charset: "utf8mb4",
        timezone: "+08:00",
      });
    }
    return this.pool;
  }

  /**
   * Count feed records for a topicId within [startDate, endDate).
   * TopicIds in 328-349 match on slaveTopicId instead of topicId.
   */
  async countFeedData(topicId: number, startDate: string, endDate: string): Promise<number> {
    const pool = await this.getPool();
    const topicField = SLAVE_TOPIC_RANGE.has(topicId) ? "f.slaveTopicId" : "f.topicId";

    const sql = `
      SELECT COUNT(*) AS cnt
      FROM feed_monitor_item f
      JOIN feed_monitor_item_data d ON f.id = d.id
      WHERE ${topicField} = ?
        AND f.date >= ?
        AND f.date < ?
        AND f.skip = 0
    `;

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(sql, [topicId, startDate, endDate]);
    return Number(rows[0]?.cnt ?? 0);
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

import mysql from "mysql2/promise";
import type { PluginLogger } from "../api.js";
import type { HistoryDbConfig, ReportTask } from "./types.js";

export class TaskPoller {
  private readonly config: HistoryDbConfig;
  private readonly pollIntervalMs: number;
  private pool: mysql.Pool | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  constructor(historyDbConfig: HistoryDbConfig, pollIntervalMs = 30000) {
    this.config = historyDbConfig;
    this.pollIntervalMs = pollIntervalMs;
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
   * Subquery resolving the recipient email from feed_report_subscriber
   * (uid + topic match, active subscriptions only). The topic mapping table
   * (entity_auth) has no email column — using it here used to break every poll.
   */
  private static readonly EMAIL_SUBQUERY = `(
        SELECT s.email FROM feed_report_subscriber s
        WHERE s.uid = d.uid AND s.active = 1
          AND s.email IS NOT NULL AND s.email != ''
          AND (s.topicId = d.topicId OR (d.slaveTopicId > 0 AND s.topicId = d.slaveTopicId))
        LIMIT 1
      ) AS userEmail`;

  async fetchPendingTasks(limit = 10): Promise<ReportTask[]> {
    const pool = await this.getPool();
    // LIMIT is inlined (sanitized integer): MySQL 8.0.22+ rejects prepared
    // LIMIT params sent by mysql2 as DOUBLE ("Incorrect arguments to
    // mysqld_stmt_execute").
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    // period IN (...) keeps us off legacy-frontend download rows
    // (period IS NULL), which are consumed by the legacy report service.
    const sql = `
      SELECT d.id, d.uid, d.topicId, d.slaveTopicId, d.category, d.period, d.status,
             d.params, d.requirement, d.title, d.content,
             ${TaskPoller.EMAIL_SUBQUERY}
      FROM download d
      WHERE d.category = 'Report' AND d.status = 'Pending'
        AND d.period IN ('Daily', 'Weekly', 'Monthly')
      ORDER BY d.id ASC
      LIMIT ${safeLimit}
    `;
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(sql);
    return rows.map((row) => ({
      ...(row as ReportTask),
      userEmail: row.userEmail ?? undefined,
    }));
  }

  /** Fetch a single report task by id (any status). Returns null if not found. */
  async fetchTaskById(id: number): Promise<ReportTask | null> {
    const pool = await this.getPool();
    const sql = `
      SELECT d.id, d.uid, d.topicId, d.slaveTopicId, d.category, d.period, d.status,
             d.params, d.requirement, d.title, d.content,
             ${TaskPoller.EMAIL_SUBQUERY}
      FROM download d
      WHERE d.id = ? AND d.category = 'Report'
        AND d.period IN ('Daily', 'Weekly', 'Monthly')
      LIMIT 1
    `;
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(sql, [id]);
    if (rows.length === 0) {
      return null;
    }
    const row = rows[0];
    return {
      ...(row as ReportTask),
      userEmail: row.userEmail ?? undefined,
    };
  }

  /**
   * Re-pend tasks stuck in Running (crash/restart recovery): a worker that
   * died between claim and completion leaves the row Running forever, which
   * neither the listener nor the poller would ever retry. Generation itself
   * is bounded (~2 min LLM timeout), so anything Running longer than
   * staleMinutes is an orphan.
   */
  async requeueStaleRunning(staleMinutes = 10): Promise<number> {
    const pool = await this.getPool();
    // Inlined (sanitized integer) for the same MySQL 8 prepared-param reason
    // as the LIMIT in fetchPendingTasks.
    const safeMinutes = Math.max(1, Math.min(1440, Math.floor(staleMinutes)));
    // Same period guard as fetchPendingTasks: never re-pend legacy-service
    // rows (period IS NULL) that another consumer may be processing.
    const [result] = await pool.execute<mysql.ResultSetHeader>(
      `UPDATE download SET status = 'Pending', updateDate = NOW()
       WHERE category = 'Report' AND status = 'Running'
         AND period IN ('Daily', 'Weekly', 'Monthly')
         AND updateDate < NOW() - INTERVAL ${safeMinutes} MINUTE`,
    );
    return result.affectedRows;
  }

  /**
   * Atomically claim a Pending task (Pending → Running). Returns false when
   * another worker (listener vs fallback poller) already claimed it.
   */
  async claimTask(id: number): Promise<boolean> {
    const pool = await this.getPool();
    const [result] = await pool.execute<mysql.ResultSetHeader>(
      "UPDATE download SET status = 'Running', updateDate = NOW() WHERE id = ? AND status = 'Pending'",
      [id],
    );
    return result.affectedRows === 1;
  }

  async updateTaskStatus(id: number, status: ReportTask["status"]): Promise<void> {
    const pool = await this.getPool();
    await pool.execute("UPDATE download SET status = ?, updateDate = NOW() WHERE id = ?", [
      status,
      id,
    ]);
  }

  async updateTaskResult(
    id: number,
    title: string,
    content: string,
    status: ReportTask["status"] = "Done",
  ): Promise<void> {
    const pool = await this.getPool();
    await pool.execute(
      "UPDATE download SET status = ?, title = ?, content = ?, updateDate = NOW() WHERE id = ?",
      [status, title, content, id],
    );
  }

  start(
    logger: PluginLogger,
    pollFn: (task: ReportTask, logger: PluginLogger) => Promise<void>,
  ): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;

    const poll = async () => {
      try {
        const requeued = await this.requeueStaleRunning();
        if (requeued > 0) {
          logger.warn(`[TASK_POLLER] Re-pended ${requeued} stale Running task(s)`);
        }
        const tasks = await this.fetchPendingTasks();
        for (const task of tasks) {
          logger.info(`[TASK_POLLER] Processing task #${task.id}`);
          await pollFn(task, logger);
        }
      } catch (error) {
        logger.error(`[TASK_POLLER] Poll error: ${String(error)}`);
      }
    };

    void poll();
    this.intervalId = setInterval(poll, this.pollIntervalMs);
    logger.info(
      `[TASK_POLLER] Started polling for pending report tasks (interval=${this.pollIntervalMs}ms)`,
    );
  }

  async stop(logger: PluginLogger): Promise<void> {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    logger.info("[TASK_POLLER] Stopped");
  }
}

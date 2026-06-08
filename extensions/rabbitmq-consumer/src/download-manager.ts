import crypto from "node:crypto";
import mysql from "mysql2/promise";
import type { ReportPeriod } from "./report-trigger.js";
import type { HistoryDbConfig, WriterDbConfig } from "./types.js";

export interface DownloadRecord {
  id: number;
  category: string;
  period: ReportPeriod | null;
  status: string;
  uid: number;
  topicId: number;
  params: string | null;
  requirement: string | null;
  title: string | null;
  data: string | null;
}

interface DownloadDbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export class DownloadManager {
  private readonly config: DownloadDbConfig;
  private pool: mysql.Pool | null = null;

  constructor(readerConfig: HistoryDbConfig, writerConfig?: WriterDbConfig) {
    // Use writer config if available, otherwise use reader config
    const host = writerConfig?.host ?? readerConfig.host;
    const port = writerConfig?.port ?? readerConfig.port;
    const user = writerConfig?.user ?? readerConfig.user;
    const password = writerConfig?.password ?? readerConfig.password;
    const database = writerConfig?.database ?? readerConfig.database;

    this.config = { host, port, user, password, database };
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
   * Create a new report task in download table.
   * Returns the inserted row ID.
   */
  async createReportTask(params: {
    uid: number;
    topicId: number;
    requirement: string;
    period: ReportPeriod;
    dateScope: { start: string; end: string };
    title?: string;
    useSlaveTopic?: boolean;
    /** Master topic id from entity_auth; stored as topicId when useSlaveTopic. */
    masterId?: number;
    /** Mercure topic for streaming generation progress to the requesting frontend. */
    mercureTopic?: string;
    /** Agent id whose workspace/skills the report subagent should run under. */
    agentId?: string;
    /**
     * report_template.id the user explicitly picked. Stored so the
     * report-generator loads that exact template instead of waterfall-resolving
     * one. Omitted for keyword-triggered reports (no explicit template).
     */
    templateId?: number;
  }): Promise<number> {
    const pool = await this.getPool();
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 19).replace("T", " ");

    const insertSql = `
      INSERT INTO download (
        slug, category, siteId, period, entityId,
        topicId, slaveTopicId, params, ip, status,
        uid, groupId, date, updateDate, memo,
        requirement, title, systemUser, deleted, altUid
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `;

    // 32-char hex slug (matches the legacy frontend's expected slug format).
    const slug = crypto.randomBytes(16).toString("hex");
    const category = "Report";
    const siteId = "legal";
    const periodDbValue: Record<string, string> = {
      日报: "Daily",
      周报: "Weekly",
      月报: "Monthly",
    };
    const period = periodDbValue[params.period] ?? params.period;
    const entityId = 0;
    const originalTopicId = params.topicId;
    // Slave mode: topicId column holds the master topic (entity_auth.masterId),
    // slaveTopicId holds the resolved slave topic (entity_auth.slaveId).
    const masterId = params.masterId ?? 0;
    const finalTopicId = params.useSlaveTopic ? masterId : originalTopicId;
    const slaveTopicId = params.useSlaveTopic ? originalTopicId : 0;
    const paramsJson = JSON.stringify({
      dateScope: `${params.dateScope.start},${params.dateScope.end}`,
      period: periodDbValue[params.period] ?? params.period,
      useSlaveTopic: params.useSlaveTopic ?? false,
      ...(params.mercureTopic ? { mercureTopic: params.mercureTopic } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.templateId ? { templateId: params.templateId } : {}),
    });
    const ip = "";
    const status = "Pending";
    const groupId = 0;
    const memo = "";
    const systemUser = 0;
    const deleted = 0;
    const altUid = 0;

    const [result] = await pool.execute<mysql.ResultSetHeader>(insertSql, [
      slug,
      category,
      siteId,
      period,
      entityId,
      finalTopicId,
      slaveTopicId,
      paramsJson,
      ip,
      status,
      params.uid,
      groupId,
      dateStr,
      dateStr,
      memo,
      params.requirement,
      params.title ?? "",
      systemUser,
      deleted,
      altUid,
    ]);

    return result.insertId;
  }

  /**
   * Update download record status and data.
   */
  async updateReportTask(
    id: number,
    updates: {
      status?: string;
      data?: string;
      title?: string;
      content?: string;
    },
  ): Promise<void> {
    const pool = await this.getPool();
    const now = new Date();
    const updateDateStr = now.toISOString().slice(0, 19).replace("T", " ");

    const setClauses: string[] = ["updateDate = ?"];
    const values: unknown[] = [updateDateStr];

    if (updates.status !== undefined) {
      setClauses.push("status = ?");
      values.push(updates.status);
    }

    if (updates.title !== undefined) {
      setClauses.push("title = ?");
      values.push(updates.title);
    }

    if (updates.content !== undefined) {
      setClauses.push("content = ?");
      values.push(updates.content);
    }

    if (updates.data !== undefined) {
      setClauses.push("data = ?");
      values.push(updates.data);
    }

    values.push(id);

    const sql = `UPDATE download SET ${setClauses.join(", ")} WHERE id = ?`;
    await pool.query(sql, values);
  }

  /**
   * Get next pending report task (oldest first).
   */
  async getNextPendingTask(): Promise<DownloadRecord | null> {
    const pool = await this.getPool();
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, category, period, status, uid, topicId, params, requirement, title, data
       FROM download
       WHERE category = 'Report' AND status = 'Pending'
       ORDER BY id ASC
       LIMIT 1`,
    );

    if (!rows || rows.length === 0) {
      return null;
    }

    return rows[0] as DownloadRecord;
  }

  /**
   * Get pending tasks count.
   */
  async getPendingCount(): Promise<number> {
    const pool = await this.getPool();
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) as cnt FROM download WHERE category = 'Report' AND status = 'Pending'`,
    );
    return rows[0]?.cnt ?? 0;
  }

  /**
   * Close connection pool.
   */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

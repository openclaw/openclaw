import mysql from "mysql2/promise";
import type { HistoryDbConfig, HistoryRecord } from "./types.js";

/**
 * Manages read/write access to the history_messages MySQL table.
 * Each operation gets its own connection from a pool.
 */
export class HistoryManager {
  private readonly config: HistoryDbConfig;
  private pool: mysql.Pool | null = null;

  constructor(config: HistoryDbConfig) {
    this.config = config;
  }

  private getPool(): mysql.Pool {
    if (this.pool) {
      return this.pool;
    }
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
    return this.pool;
  }

  /** Fetch a history record by ID. Returns null if not found. */
  async getRecord(historyId: number): Promise<HistoryRecord | null> {
    const pool = this.getPool();
    const [rows] = await pool.execute<
      mysql.RowDataPacket[]
    >(
      `SELECT id, session_id, user_id, message, response, tools_used, metadata, created_at
       FROM history_messages WHERE id = ?`,
      [historyId],
    );

    if (!rows || rows.length === 0) {
      return null;
    }

    const row = rows[0];
    return {
      id: row.id,
      sessionId: row.session_id ?? "",
      userId: row.user_id ?? "",
      message: row.message ?? "",
      response: row.response ?? null,
      toolsUsed: row.tools_used ?? null,
      metadata: row.metadata ?? null,
      createdAt: row.created_at,
    };
  }

  /** Update the response field for a history record. */
  async updateResponse(historyId: number, response: string): Promise<void> {
    const pool = this.getPool();
    await pool.execute(
      "UPDATE history_messages SET response = ? WHERE id = ?",
      [response, historyId],
    );
  }

  /** Close the connection pool. */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

import mysql from "mysql2/promise";
import type { HistoryDbConfig, WriterDbConfig, HistoryRecord } from "./types.js";

/**
 * Manages read/write access to the history_messages MySQL table.
 * Uses separate connection pools: reader for SELECT, writer for UPDATE/INSERT.
 * Falls back to the reader pool for writes when no writer config is provided.
 */
export class HistoryManager {
  private readonly readerConfig: HistoryDbConfig;
  private readonly writerConfig: WriterDbConfig | null;
  private readerPool: mysql.Pool | null = null;
  private writerPool: mysql.Pool | null = null;

  constructor(readerConfig: HistoryDbConfig, writerConfig?: WriterDbConfig) {
    this.readerConfig = readerConfig;
    this.writerConfig = writerConfig ?? null;
  }

  private createPool(config: HistoryDbConfig | WriterDbConfig): mysql.Pool {
    return mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: 3,
      waitForConnections: true,
      charset: "utf8mb4",
      timezone: "+08:00",
    });
  }

  private getReaderPool(): mysql.Pool {
    if (!this.readerPool) {
      this.readerPool = this.createPool(this.readerConfig);
    }
    return this.readerPool;
  }

  private getWriterPool(): mysql.Pool {
    if (!this.writerPool && this.writerConfig) {
      this.writerPool = this.createPool(this.writerConfig);
    }
    // Fallback to reader pool when no dedicated writer is configured.
    return this.writerPool ?? this.getReaderPool();
  }

  /** Fetch a history record by ID. Returns null if not found. */
  async getRecord(historyId: number): Promise<HistoryRecord | null> {
    const pool = this.getReaderPool();
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
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
    const pool = this.getWriterPool();
    await pool.execute("UPDATE history_messages SET response = ? WHERE id = ?", [
      response,
      historyId,
    ]);
  }

  /** Close all connection pools. */
  async close(): Promise<void> {
    if (this.readerPool) {
      await this.readerPool.end();
      this.readerPool = null;
    }
    if (this.writerPool) {
      await this.writerPool.end();
      this.writerPool = null;
    }
  }
}

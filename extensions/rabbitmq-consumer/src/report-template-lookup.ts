import mysql from "mysql2/promise";
import type { PluginLogger } from "../api.js";
import type { ReportPeriod } from "./report-trigger.js";
import type { HistoryDbConfig } from "./types.js";

/** report_template.period as stored in the DB (English enum). */
type DbPeriod = "Daily" | "Weekly" | "Monthly";

const DB_PERIOD_TO_CHINESE: Record<DbPeriod, ReportPeriod> = {
  Daily: "日报",
  Weekly: "周报",
  Monthly: "月报",
};

/** Minimal report_template projection needed to queue an explicit report task. */
export interface ResolvedTemplate {
  id: number;
  /** Period mapped to the Chinese ReportPeriod the report pipeline uses. */
  period: ReportPeriod;
  name: string;
}

/**
 * Resolve a report_template row by id for an explicit template-driven report
 * request. Only the period (which drives the date scope) is needed here — the
 * report-generator loads the template body itself by the same id.
 *
 * Ownership is enforced: a user may only drive reports from their own templates
 * (user_id = uid) or system templates (user_id IS NULL), and only enabled ones.
 */
export class ReportTemplateLookup {
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
   * Look up an enabled template visible to the user. Returns null when the id
   * does not exist, is disabled, belongs to another user, or carries an
   * unknown period — the caller then falls back to ordinary chat handling.
   */
  async resolve(
    templateId: number,
    userId: string,
    logger: PluginLogger,
  ): Promise<ResolvedTemplate | null> {
    try {
      const pool = await this.getPool();
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT id, period, name
         FROM report_template
         WHERE id = ?
           AND is_enable = 1
           AND (user_id = ? OR user_id IS NULL)
         LIMIT 1`,
        [templateId, userId],
      );

      const row = rows[0];
      if (!row) {
        logger.warn(
          `[TEMPLATE_LOOKUP] Template #${templateId} not found / not visible for user ${userId}`,
        );
        return null;
      }

      const dbPeriod = row.period as string;
      const period = DB_PERIOD_TO_CHINESE[dbPeriod as DbPeriod];
      if (!period) {
        logger.warn(
          `[TEMPLATE_LOOKUP] Template #${templateId} has unknown period "${dbPeriod}", ignoring`,
        );
        return null;
      }

      return {
        id: Number(row.id),
        period,
        name: typeof row.name === "string" ? row.name : "",
      };
    } catch (error) {
      logger.error(`[TEMPLATE_LOOKUP] Lookup failed for #${templateId}: ${String(error)}`);
      return null;
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

import mysql from "mysql2/promise";
import type { PluginLogger } from "../api.js";
import type { HistoryDbConfig, ReportPeriod } from "./types.js";

interface TemplateRow {
  id: number;
  user_id: number | null;
  topic_id: number | null;
  name: string;
  content: string | null;
}

/** Last-resort templates used only when the DB is unreachable or empty. */
const FALLBACK_TEMPLATES: Record<ReportPeriod, string> = {
  Daily: `# 日报模板

## 概述
{summary}

## 数据概览
- 数据时间范围：{dateScope}
- 数据总量：{totalCount} 条
- 涉及平台：{platforms}

## 舆情摘要
{summaryContent}

## 重点关注
{keyPoints}

## 情感分析
{emotionAnalysis}

## 风险提示
{riskAlerts}

## 建议
{recommendations}
`,

  Weekly: `# 周报模板

## 概述
{summary}

## 数据概览
- 数据时间范围：{dateScope}
- 数据总量：{totalCount} 条
- 日均数据量：{dailyAvg} 条
- 涉及平台：{platforms}

## 本周舆情趋势
{trendAnalysis}

## 舆情摘要
{summaryContent}

## 重点关注
{keyPoints}

## 情感分析
{emotionAnalysis}

## 风险提示
{riskAlerts}

## 建议
{recommendations}
`,

  Monthly: `# 月报模板

## 概述
{summary}

## 数据概览
- 数据时间范围：{dateScope}
- 数据总量：{totalCount} 条
- 日均数据量：{dailyAvg} 条
- 涉及平台：{platforms}

## 本月舆情趋势
{trendAnalysis}

## 舆情摘要
{summaryContent}

## 重点关注
{keyPoints}

## 情感分析
{emotionAnalysis}

## 风险提示
{riskAlerts}

## 建议
{recommendations}
`,
};

export class TemplateLoader {
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
   * Load report template from report_template with a waterfall resolution,
   * implemented as a single indexed query ordered by specificity:
   *   1. user template bound to the topic
   *   2. user default template (is_default = 1)
   *   3. any enabled user template
   *   4. system built-in template (user_id IS NULL)
   *   5. code-level FALLBACK_TEMPLATES (DB unreachable or empty)
   */
  async loadTemplate(
    period: ReportPeriod,
    userId: number,
    logger: PluginLogger,
    topicId?: number,
  ): Promise<string> {
    try {
      const pool = await this.getPool();
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT id, user_id, topic_id, name, content
         FROM report_template
         WHERE period = ?
           AND is_enable = 1
           AND (user_id = ? OR user_id IS NULL)
           AND (topic_id IS NULL OR topic_id = ?)
         ORDER BY
           (user_id IS NOT NULL) DESC,
           (topic_id IS NOT NULL) DESC,
           is_default DESC,
           updated_at DESC
         LIMIT 1`,
        [period, userId, topicId ?? null],
      );

      const row = rows[0] as TemplateRow | undefined;
      if (!row) {
        logger.info(
          `[TEMPLATE_LOADER] No ${period} template for user ${userId}, using code fallback`,
        );
        return FALLBACK_TEMPLATES[period];
      }
      if (!row.content) {
        logger.warn(
          `[TEMPLATE_LOADER] Template "${row.name}" (#${row.id}) has empty content, using code fallback`,
        );
        return FALLBACK_TEMPLATES[period];
      }

      const scope = row.user_id === null ? "system" : row.topic_id === null ? "user" : "topic";
      logger.info(
        `[TEMPLATE_LOADER] Loaded ${scope} template "${row.name}" (#${row.id}) for ${period}`,
      );
      return row.content;
    } catch (error) {
      logger.error(`[TEMPLATE_LOADER] Failed to load template: ${String(error)}`);
      return FALLBACK_TEMPLATES[period];
    }
  }

  /**
   * Load a specific template the user picked in the frontend's template panel.
   * Ownership is enforced (own template or system template, enabled only); any
   * miss — deleted, disabled, another user's id, empty content, or a DB error —
   * degrades to the waterfall resolution so a report is still produced.
   */
  async loadTemplateById(
    templateId: number,
    userId: number,
    period: ReportPeriod,
    logger: PluginLogger,
  ): Promise<string> {
    try {
      const pool = await this.getPool();
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT id, user_id, topic_id, name, content
         FROM report_template
         WHERE id = ?
           AND is_enable = 1
           AND (user_id = ? OR user_id IS NULL)
         LIMIT 1`,
        [templateId, userId],
      );

      const row = rows[0] as TemplateRow | undefined;
      if (!row || !row.content) {
        logger.warn(
          `[TEMPLATE_LOADER] Explicit template #${templateId} not usable for user ${userId} ` +
            `(missing/disabled/empty); falling back to waterfall`,
        );
        return this.loadTemplate(period, userId, logger);
      }

      logger.info(
        `[TEMPLATE_LOADER] Loaded explicit template "${row.name}" (#${row.id}) for ${period}`,
      );
      return row.content;
    } catch (error) {
      logger.error(
        `[TEMPLATE_LOADER] Failed to load explicit template #${templateId}: ${String(error)}`,
      );
      return this.loadTemplate(period, userId, logger);
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

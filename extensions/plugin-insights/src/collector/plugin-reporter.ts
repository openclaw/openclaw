import type Database from "better-sqlite3";
import type { InsightsAPIReport } from "../types.js";

/**
 * Layer 3: Insights API (Self-Report)
 *
 * Other plugins can report their own activity for precise attribution.
 * Reports are session-scoped: only reports matching the current session
 * are flushed to a turn, preventing cross-session contamination.
 *
 * Usage via after_tool_call or direct DB access:
 *   reporter.report({ pluginId: "my-plugin", action: "recall", sessionId });
 */
export class PluginReporter {
  private db: Database.Database;
  private pendingReports: InsightsAPIReport[] = [];

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Accept a report from an external plugin */
  report(data: InsightsAPIReport): void {
    this.pendingReports.push(data);
  }

  /** Flush pending reports that match the given session and associate them with a turn.
   *  Reports without a sessionId are always flushed (backwards-compatible). */
  flushToTurn(turnId: number, sessionId?: string): void {
    if (this.pendingReports.length === 0) return;

    // Partition: matching (flush now) vs non-matching (keep)
    const toFlush: InsightsAPIReport[] = [];
    const toKeep: InsightsAPIReport[] = [];

    for (const report of this.pendingReports) {
      if (!report.sessionId || !sessionId || report.sessionId === sessionId) {
        toFlush.push(report);
      } else {
        toKeep.push(report);
      }
    }

    if (toFlush.length === 0) {
      return;
    }

    const insert = this.db.prepare(`
      INSERT INTO plugin_events (turn_id, plugin_id, detection_method, action, metadata_json)
      VALUES (?, ?, 'self_report', ?, ?)
    `);

    const tx = this.db.transaction(() => {
      for (const report of toFlush) {
        insert.run(
          turnId,
          report.pluginId,
          report.action,
          report.metadata ? JSON.stringify(report.metadata) : null
        );
      }
    });
    tx();

    this.pendingReports = toKeep;
  }

  /** Get pending reports count (for testing) */
  getPendingCount(): number {
    return this.pendingReports.length;
  }
}

/** The public API that other plugins can call */
export interface PluginInsightsPublicAPI {
  report(data: InsightsAPIReport): void;
}

import type Database from "better-sqlite3";
import type { TriggerFrequencyResult } from "../types.js";

export class TriggerFrequencyMetric {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  compute(pluginId: string, days: number = 30): TriggerFrequencyResult {
    const since = daysAgo(days);

    // Total trigger count
    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM plugin_events
         WHERE plugin_id = ? AND created_at >= ?`
      )
      .get(pluginId, since) as { cnt: number };

    // Daily breakdown
    const dailyRows = this.db
      .prepare(
        `SELECT date(created_at) as date, COUNT(*) as cnt
         FROM plugin_events
         WHERE plugin_id = ? AND created_at >= ?
         GROUP BY date(created_at)
         ORDER BY date(created_at)`
      )
      .all(pluginId, since) as { date: string; cnt: number }[];

    // Unique sessions where plugin was triggered
    const sessionRow = this.db
      .prepare(
        `SELECT COUNT(DISTINCT t.session_id) as cnt
         FROM plugin_events pe
         JOIN turns t ON pe.turn_id = t.id
         WHERE pe.plugin_id = ? AND pe.created_at >= ?`
      )
      .get(pluginId, since) as { cnt: number };

    const totalTriggers = totalRow.cnt;
    // Use the report window (days) as denominator, not just days-with-triggers.
    // This avoids inflating triggersPerDay when the plugin is only active on
    // a few days within the window.
    const windowDays = Math.max(days, 1);
    const sessions = Math.max(sessionRow.cnt, 1);

    return {
      pluginId,
      totalTriggers,
      triggersPerDay: round(totalTriggers / windowDays),
      triggersPerSession: round(totalTriggers / sessions),
      dailyTrend: dailyRows.map((r) => ({ date: r.date, count: r.cnt })),
    };
  }

  /** Get all plugin IDs that have events */
  getActivePlugins(days: number = 30): string[] {
    const since = daysAgo(days);
    const rows = this.db
      .prepare(
        `SELECT DISTINCT plugin_id FROM plugin_events WHERE created_at >= ?`
      )
      .all(since) as { plugin_id: string }[];
    return rows.map((r) => r.plugin_id);
  }
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function round(n: number, decimals: number = 1): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

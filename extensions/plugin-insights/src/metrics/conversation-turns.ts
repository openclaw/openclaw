import type Database from "better-sqlite3";
import type { ConversationTurnsResult } from "../types.js";
import { daysAgo, round } from "../utils.js";

export class ConversationTurnsMetric {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  compute(pluginId: string, days: number = 30): ConversationTurnsResult {
    const since = daysAgo(days);

    // Sessions where this plugin was frequently triggered (>= 2 times)
    const sessionsWithPlugin = this.db
      .prepare(
        `SELECT t.session_id, COUNT(DISTINCT t.id) as turn_count
         FROM turns t
         WHERE t.session_id IN (
           SELECT DISTINCT t2.session_id
           FROM plugin_events pe
           JOIN turns t2 ON pe.turn_id = t2.id
           WHERE pe.plugin_id = ? AND pe.created_at >= ?
           GROUP BY t2.session_id
           HAVING COUNT(*) >= 2
         )
         AND t.timestamp >= ?
         GROUP BY t.session_id`
      )
      .all(pluginId, since, since) as { session_id: string; turn_count: number }[];

    // Sessions where this plugin was rarely or never triggered (0-1 times)
    const sessionsWithoutPlugin = this.db
      .prepare(
        `SELECT t.session_id, COUNT(*) as turn_count
         FROM turns t
         WHERE t.timestamp >= ?
         AND t.session_id NOT IN (
           SELECT DISTINCT t2.session_id
           FROM plugin_events pe
           JOIN turns t2 ON pe.turn_id = t2.id
           WHERE pe.plugin_id = ? AND pe.created_at >= ?
           GROUP BY t2.session_id
           HAVING COUNT(*) >= 2
         )
         GROUP BY t.session_id`
      )
      .all(since, pluginId, since) as { session_id: string; turn_count: number }[];

    const avgWith = average(sessionsWithPlugin.map((s) => s.turn_count));
    const avgWithout = average(sessionsWithoutPlugin.map((s) => s.turn_count));
    const delta = avgWith - avgWithout;
    const deltaPercent = avgWithout > 0 ? (delta / avgWithout) * 100 : 0;

    return {
      pluginId,
      avgTurnsWithPlugin: round(avgWith),
      avgTurnsWithoutPlugin: round(avgWithout),
      deltaTurns: round(delta),
      deltaPercent: round(deltaPercent),
    };
  }
}

function average(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}


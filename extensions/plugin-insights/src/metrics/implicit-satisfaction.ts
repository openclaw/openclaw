import type Database from "better-sqlite3";
import type { ImplicitSatisfactionResult } from "../types.js";
import { daysAgo, round } from "../utils.js";

export class ImplicitSatisfactionMetric {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  compute(pluginId: string, days: number = 30): ImplicitSatisfactionResult {
    const since = daysAgo(days);

    // Get satisfaction signals for turns where this plugin was triggered.
    // Use a subquery to deduplicate: a turn with multiple plugin_events
    // for the same plugin should only count its satisfaction signal once.
    const signals = this.db
      .prepare(
        `SELECT ss.signal_type, COUNT(*) as cnt
         FROM satisfaction_signals ss
         WHERE ss.turn_id IN (
           SELECT DISTINCT pe.turn_id FROM plugin_events pe
           WHERE pe.plugin_id = ? AND pe.created_at >= ?
         )
           AND ss.created_at >= ?
         GROUP BY ss.signal_type`,
      )
      .all(pluginId, since, since) as { signal_type: string; cnt: number }[];

    let accepted = 0;
    let retried = 0;
    let corrected = 0;

    for (const s of signals) {
      switch (s.signal_type) {
        case "accepted":
          accepted = s.cnt;
          break;
        case "retried":
          retried = s.cnt;
          break;
        case "corrected":
          corrected = s.cnt;
          break;
      }
    }

    const total = accepted + retried + corrected;

    return {
      pluginId,
      acceptanceRate: total > 0 ? round((accepted / total) * 100) : 0,
      retryRate: total > 0 ? round((retried / total) * 100) : 0,
      correctionRate: total > 0 ? round((corrected / total) * 100) : 0,
      totalSignals: total,
    };
  }
}

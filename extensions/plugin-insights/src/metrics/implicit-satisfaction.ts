import type Database from "better-sqlite3";
import type { ImplicitSatisfactionResult } from "../types.js";

export class ImplicitSatisfactionMetric {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  compute(pluginId: string, days: number = 30): ImplicitSatisfactionResult {
    const since = daysAgo(days);

    // Get satisfaction signals for turns where this plugin was triggered
    const signals = this.db
      .prepare(
        `SELECT ss.signal_type, COUNT(*) as cnt
         FROM satisfaction_signals ss
         JOIN plugin_events pe ON pe.turn_id = ss.turn_id
         WHERE pe.plugin_id = ? AND ss.created_at >= ?
         GROUP BY ss.signal_type`
      )
      .all(pluginId, since) as { signal_type: string; cnt: number }[];

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

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function round(n: number, decimals: number = 1): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

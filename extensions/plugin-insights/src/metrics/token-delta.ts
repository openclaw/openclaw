import type Database from "better-sqlite3";
import type { TokenDeltaResult } from "../types.js";
import { daysAgo, round } from "../utils.js";

// Approximate pricing per 1M tokens (GPT-4o class)
const DEFAULT_COST_PER_1M_INPUT = 2.5;
const DEFAULT_COST_PER_1M_OUTPUT = 10.0;
const DEFAULT_COST_PER_1M_BLENDED = 5.0;

export class TokenDeltaMetric {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  compute(pluginId: string, days: number = 30): TokenDeltaResult {
    const since = daysAgo(days);

    // Average tokens for turns where this plugin was triggered.
    // Use a subquery to deduplicate: a turn with multiple plugin_events
    // for the same plugin should only be counted once.
    const withPlugin = this.db
      .prepare(
        `SELECT
           AVG(t.total_tokens) as avg_total,
           AVG(t.prompt_tokens) as avg_prompt,
           AVG(t.completion_tokens) as avg_completion,
           COUNT(*) as cnt
         FROM turns t
         WHERE t.id IN (
           SELECT DISTINCT pe.turn_id FROM plugin_events pe
           WHERE pe.plugin_id = ? AND pe.created_at >= ?
         )
           AND t.timestamp >= ?
           AND t.total_tokens IS NOT NULL`,
      )
      .get(pluginId, since, since) as {
      avg_total: number | null;
      avg_prompt: number | null;
      avg_completion: number | null;
      cnt: number;
    };

    // Average tokens for turns where NO plugin was triggered
    const withoutPlugin = this.db
      .prepare(
        `SELECT
           AVG(total_tokens) as avg_total,
           AVG(prompt_tokens) as avg_prompt,
           AVG(completion_tokens) as avg_completion,
           COUNT(*) as cnt
         FROM turns
         WHERE timestamp >= ?
           AND total_tokens IS NOT NULL
           AND (plugins_triggered_json IS NULL OR plugins_triggered_json = '[]')`,
      )
      .get(since) as {
      avg_total: number | null;
      avg_prompt: number | null;
      avg_completion: number | null;
      cnt: number;
    };

    const avgWith = withPlugin.avg_total ?? 0;
    const avgWithout = withoutPlugin.avg_total ?? 0;
    const delta = avgWith - avgWithout;
    const deltaPercent = avgWithout > 0 ? (delta / avgWithout) * 100 : 0;

    // Estimate monthly cost: assume 30 triggers/day * 30 days
    const triggersPerMonth = withPlugin.cnt > 0 ? (withPlugin.cnt / days) * 30 : 0;
    const extraTokensPerMonth = delta > 0 ? delta * triggersPerMonth : 0;
    const estimatedCost = (extraTokensPerMonth / 1_000_000) * DEFAULT_COST_PER_1M_BLENDED;

    return {
      pluginId,
      avgTokensWithPlugin: round(avgWith),
      avgTokensWithoutPlugin: round(avgWithout),
      deltaTokens: round(delta),
      deltaPercent: round(deltaPercent),
      estimatedMonthlyCostUSD: round(estimatedCost, 2),
    };
  }
}

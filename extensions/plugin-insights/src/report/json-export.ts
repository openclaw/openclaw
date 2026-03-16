import type Database from "better-sqlite3";
import type { InsightsReport } from "../types.js";
import * as fs from "node:fs";

export interface ExportOptions {
  format: "json" | "jsonl";
  output?: string;
  pretty?: boolean;
}

/** Export full insights report as JSON */
export function exportJSON(
  report: InsightsReport,
  options: ExportOptions
): string {
  const content =
    options.format === "jsonl"
      ? report.plugins.map((p) => JSON.stringify(p)).join("\n")
      : JSON.stringify(report, null, options.pretty !== false ? 2 : undefined);

  if (options.output) {
    fs.writeFileSync(options.output, content, "utf-8");
  }

  return content;
}

/** Export raw data from tables for advanced analysis */
export function exportRawData(
  db: Database.Database,
  options: ExportOptions & { days?: number }
): string {
  const days = options.days ?? 30;
  const since = daysAgo(days);

  const turns = db
    .prepare("SELECT * FROM turns WHERE timestamp >= ? ORDER BY timestamp")
    .all(since);

  const events = db
    .prepare(
      `SELECT pe.* FROM plugin_events pe
       JOIN turns t ON pe.turn_id = t.id
       WHERE t.timestamp >= ?
       ORDER BY pe.created_at`
    )
    .all(since);

  const signals = db
    .prepare(
      `SELECT ss.* FROM satisfaction_signals ss
       JOIN turns t ON ss.turn_id = t.id
       WHERE t.timestamp >= ?
       ORDER BY ss.created_at`
    )
    .all(since);

  const scores = db
    .prepare(
      `SELECT ls.* FROM llm_scores ls
       JOIN turns t ON ls.turn_id = t.id
       WHERE t.timestamp >= ?
       ORDER BY ls.created_at`
    )
    .all(since);

  // Include unmapped tools for coverage context
  const unmappedTools = db
    .prepare(
      `SELECT tool_name, call_count FROM observed_unmapped_tools
       WHERE tool_name NOT IN (SELECT tool_name FROM tool_plugin_mapping)
       ORDER BY call_count DESC`
    )
    .all() as { tool_name: string; call_count: number }[];

  const data = {
    exportedAt: new Date().toISOString(),
    periodDays: days,
    coverage: {
      isComplete: unmappedTools.length === 0,
      unmappedTools: unmappedTools.map((r) => ({
        toolName: r.tool_name,
        callCount: r.call_count,
      })),
    },
    turns,
    pluginEvents: events,
    satisfactionSignals: signals,
    llmScores: scores,
  };

  const content = JSON.stringify(data, null, options.pretty !== false ? 2 : undefined);

  if (options.output) {
    fs.writeFileSync(options.output, content, "utf-8");
  }

  return content;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

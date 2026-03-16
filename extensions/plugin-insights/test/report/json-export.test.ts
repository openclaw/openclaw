import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runMigrations } from "../../src/db/migration.js";
import { exportJSON, exportRawData } from "../../src/report/json-export.js";
import type { InsightsReport, PluginReport } from "../../src/types.js";

function makeReport(): InsightsReport {
  return {
    periodStart: "2026-02-14",
    periodEnd: "2026-03-16",
    generatedAt: new Date().toISOString(),
    plugins: [
      {
        pluginId: "test",
        pluginName: "Test",
        installedDays: 30,
        triggerFrequency: {
          pluginId: "test",
          totalTriggers: 10,
          triggersPerDay: 1,
          triggersPerSession: 1,
          dailyTrend: [],
        },
        tokenDelta: {
          pluginId: "test",
          avgTokensWithPlugin: 1000,
          avgTokensWithoutPlugin: 800,
          deltaTokens: 200,
          deltaPercent: 25,
          estimatedMonthlyCostUSD: 0.3,
        },
        conversationTurns: {
          pluginId: "test",
          avgTurnsWithPlugin: 4,
          avgTurnsWithoutPlugin: 5,
          deltaTurns: -1,
          deltaPercent: -20,
        },
        implicitSatisfaction: {
          pluginId: "test",
          acceptanceRate: 80,
          retryRate: 15,
          correctionRate: 5,
          totalSignals: 20,
        },
        verdict: { level: "keep", label: "KEEP", reason: "Good" },
      } as PluginReport,
    ],
  };
}

describe("exportJSON", () => {
  it("should export as formatted JSON", () => {
    const report = makeReport();
    const content = exportJSON(report, { format: "json" });
    const parsed = JSON.parse(content);
    expect(parsed.plugins).toHaveLength(1);
    expect(parsed.periodStart).toBe("2026-02-14");
  });

  it("should export as JSONL", () => {
    const report = makeReport();
    const content = exportJSON(report, { format: "jsonl" });
    const lines = content.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.pluginId).toBe("test");
  });

  it("should export compact JSON when pretty=false", () => {
    const report = makeReport();
    const pretty = exportJSON(report, { format: "json", pretty: true });
    const compact = exportJSON(report, { format: "json", pretty: false });
    expect(compact.length).toBeLessThan(pretty.length);
  });
});

describe("exportRawData", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);

    db.prepare(
      `INSERT INTO turns (session_id, turn_index, timestamp, total_tokens)
       VALUES ('s1', 0, datetime('now'), 500)`,
    ).run();
    db.prepare(
      `INSERT INTO plugin_events (turn_id, plugin_id, detection_method, action)
       VALUES (1, 'mem', 'tool_call', 'search')`,
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  it("should export raw data with all tables and coverage", () => {
    const content = exportRawData(db, { format: "json" });
    const parsed = JSON.parse(content);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.pluginEvents).toHaveLength(1);
    expect(parsed.satisfactionSignals).toHaveLength(0);
    expect(parsed.llmScores).toHaveLength(0);
    expect(parsed.exportedAt).toBeTruthy();
    expect(parsed.coverage).toBeDefined();
    expect(parsed.coverage.isComplete).toBe(true);
    expect(parsed.coverage.unmappedTools).toHaveLength(0);
  });
});

import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ToolDetector } from "../../src/collector/tool-detector.js";
import { runMigrations } from "../../src/db/migration.js";
import { createInsightsCompareTool } from "../../src/tools/insights-compare.js";
import { createInsightsShowTool } from "../../src/tools/insights-show.js";
import type { PluginInsightsConfig, AgentToolResult } from "../../src/types.js";
import { DEFAULT_CONFIG } from "../../src/types.js";

/** Extract text from an AgentToolResult */
function resultText(result: AgentToolResult): string {
  return (result.content[0] as { type: "text"; text: string }).text;
}

describe("insights_show tool handler", () => {
  let db: Database.Database;
  let toolDetector: ToolDetector;
  const config: PluginInsightsConfig = { ...DEFAULT_CONFIG };

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    toolDetector = new ToolDetector(db);
  });

  afterEach(() => {
    db.close();
  });

  it("should return 'no data' message when database is empty", async () => {
    const tool = createInsightsShowTool(db, config, toolDetector);
    const result = await tool.execute("test-call-id", {});
    expect(resultText(result)).toContain("No plugin attribution data");
  });

  it("should return a full report when data exists", async () => {
    seedTestData(db);

    const tool = createInsightsShowTool(db, config, toolDetector);
    const result = await tool.execute("test-call-id", {});

    expect(resultText(result)).toContain("Plugin Insights Report");
    expect(resultText(result)).toContain("mem");
  });

  it("should filter by plugin ID", async () => {
    seedTestData(db);

    const tool = createInsightsShowTool(db, config, toolDetector);
    const result = await tool.execute("test-call-id", { plugin: "mem" });

    expect(resultText(result)).toContain("mem");
    expect(resultText(result)).toContain("Triggers:");
  });

  it("should return error for unknown plugin ID", async () => {
    seedTestData(db);

    const tool = createInsightsShowTool(db, config, toolDetector);
    const result = await tool.execute("test-call-id", { plugin: "nonexistent" });

    expect(resultText(result)).toContain("No data found");
    expect(resultText(result)).toContain("Available plugins");
  });

  it("should respect days parameter", async () => {
    // Insert old data (40 days ago) — both timestamp and created_at must be old
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, timestamp, plugins_triggered_json)
       VALUES ('s1', 0, datetime('now', '-40 days'), '["old-plug"]')`,
    ).run();
    db.prepare(
      `INSERT INTO plugin_events (turn_id, plugin_id, detection_method, action, created_at)
       VALUES (1, 'old-plug', 'tool_call', 'x', datetime('now', '-40 days'))`,
    ).run();

    const tool = createInsightsShowTool(db, config, toolDetector);

    // 30 days should NOT include the old data
    const result30 = await tool.execute("test-call-id", { days: 30 });
    expect(resultText(result30)).toContain("No plugin attribution data");

    // 60 days SHOULD include it
    const result60 = await tool.execute("test-call-id", { days: 60 });
    expect(resultText(result60)).toContain("old-plug");
  });
});

describe("insights_compare tool handler", () => {
  let db: Database.Database;
  let toolDetector: ToolDetector;
  const config: PluginInsightsConfig = { ...DEFAULT_CONFIG };

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    toolDetector = new ToolDetector(db);
  });

  afterEach(() => {
    db.close();
  });

  it("should compare two plugins", async () => {
    seedTwoPlugins(db);

    const tool = createInsightsCompareTool(db, config, toolDetector);
    const result = await tool.execute("test-call-id", { pluginA: "mem", pluginB: "fmt" });

    expect(resultText(result)).toContain("mem");
    expect(resultText(result)).toContain("fmt");
    expect(resultText(result)).toContain("Total triggers");
    expect(resultText(result)).toContain("Verdict");
  });

  it("should handle missing pluginA", async () => {
    seedTwoPlugins(db);

    const tool = createInsightsCompareTool(db, config, toolDetector);
    const result = await tool.execute("test-call-id", { pluginA: "nonexistent", pluginB: "fmt" });

    expect(resultText(result)).toContain("No data found");
    expect(resultText(result)).toContain("nonexistent");
  });

  it("should handle both plugins missing", async () => {
    const tool = createInsightsCompareTool(db, config, toolDetector);
    const result = await tool.execute("test-call-id", { pluginA: "a", pluginB: "b" });

    expect(resultText(result)).toContain("No data found");
  });
});

// --- Seed helpers ---

function seedTestData(db: Database.Database) {
  for (let i = 0; i < 10; i++) {
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, timestamp, total_tokens, plugins_triggered_json)
       VALUES ('s${i}', 0, datetime('now', '-${i} hours'), 500, '["mem"]')`,
    ).run();
    db.prepare(
      `INSERT INTO plugin_events (turn_id, plugin_id, detection_method, action)
       VALUES (${i + 1}, 'mem', 'tool_call', 'memory_search')`,
    ).run();
  }
}

function seedTwoPlugins(db: Database.Database) {
  for (let i = 0; i < 10; i++) {
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, timestamp, total_tokens, plugins_triggered_json)
       VALUES ('s${i}', 0, datetime('now', '-${i} hours'), 500, '["mem"]')`,
    ).run();
    db.prepare(
      `INSERT INTO plugin_events (turn_id, plugin_id, detection_method, action)
       VALUES (${i + 1}, 'mem', 'tool_call', 'search')`,
    ).run();
  }
  for (let i = 0; i < 6; i++) {
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, timestamp, total_tokens, plugins_triggered_json)
       VALUES ('sf${i}', 0, datetime('now', '-${i} hours'), 300, '["fmt"]')`,
    ).run();
    db.prepare(
      `INSERT INTO plugin_events (turn_id, plugin_id, detection_method, action)
       VALUES (${10 + i + 1}, 'fmt', 'tool_call', 'format')`,
    ).run();
  }
}

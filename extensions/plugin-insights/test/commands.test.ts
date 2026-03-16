import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ToolDetector } from "../src/collector/tool-detector.js";
import { createCommands } from "../src/commands.js";
import { runMigrations } from "../src/db/migration.js";
import type { PluginInsightsConfig, PluginCommandContext } from "../src/types.js";
import { DEFAULT_CONFIG } from "../src/types.js";

function mkCommandContext(overrides?: Partial<PluginCommandContext>): PluginCommandContext {
  return {
    channel: "test",
    isAuthorizedSender: true,
    commandBody: "",
    config: {},
    ...overrides,
  };
}

describe("CLI Commands", () => {
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

  it("should create all 6 commands", () => {
    const commands = createCommands(db, config, toolDetector);
    expect(commands).toHaveLength(6);

    const names = commands.map((c) => c.name);
    expect(names).toContain("insights-show");
    expect(names).toContain("insights-compare");
    expect(names).toContain("insights-export");
    expect(names).toContain("insights-dashboard");
    expect(names).toContain("insights-reset");
    expect(names).toContain("insights-status");
  });

  it("insights-show should handle empty data", () => {
    const commands = createCommands(db, config, toolDetector);
    const showCmd = commands.find((c) => c.name === "insights-show")!;

    const result = showCmd.handler(mkCommandContext());
    expect(result).toBeDefined();
    expect((result as { text?: string }).text).toContain("No plugin activity");
  });

  it("insights-reset without --confirm should show warning", () => {
    const commands = createCommands(db, config, toolDetector);
    const resetCmd = commands.find((c) => c.name === "insights-reset")!;

    const result = resetCmd.handler(mkCommandContext());
    expect((result as { text?: string }).text).toContain("permanently delete");
  });

  it("insights-reset with --confirm should delete all data", () => {
    // Seed data
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, timestamp) VALUES ('s1', 0, datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO plugin_events (turn_id, plugin_id, detection_method, action) VALUES (1, 'mem', 'tool_call', 'x')`,
    ).run();

    const commands = createCommands(db, config, toolDetector);
    const resetCmd = commands.find((c) => c.name === "insights-reset")!;

    const result = resetCmd.handler(
      mkCommandContext({ args: "--confirm", commandBody: "insights-reset --confirm" }),
    );

    const turns = db.prepare("SELECT * FROM turns").all();
    expect(turns).toHaveLength(0);
    const events = db.prepare("SELECT * FROM plugin_events").all();
    expect(events).toHaveLength(0);

    expect((result as { text?: string }).text).toContain("reset");
  });
});

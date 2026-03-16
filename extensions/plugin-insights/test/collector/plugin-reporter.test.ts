import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PluginReporter } from "../../src/collector/plugin-reporter.js";
import { runMigrations } from "../../src/db/migration.js";

describe("PluginReporter", () => {
  let db: Database.Database;
  let reporter: PluginReporter;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    reporter = new PluginReporter(db);

    // Insert a turn to reference
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, timestamp) VALUES ('s1', 0, datetime('now'))`,
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  it("should accumulate reports and flush to turn", () => {
    reporter.report({ pluginId: "my-plugin", action: "recall", metadata: { count: 5 } });
    reporter.report({ pluginId: "my-plugin", action: "store" });

    expect(reporter.getPendingCount()).toBe(2);

    reporter.flushToTurn(1);

    expect(reporter.getPendingCount()).toBe(0);

    const events = db.prepare("SELECT * FROM plugin_events WHERE turn_id = 1").all() as any[];
    expect(events).toHaveLength(2);
    expect(events[0].detection_method).toBe("self_report");
    expect(events[0].plugin_id).toBe("my-plugin");
    expect(events[0].action).toBe("recall");
  });

  it("should handle empty flush gracefully", () => {
    reporter.flushToTurn(1);
    const events = db.prepare("SELECT * FROM plugin_events WHERE turn_id = 1").all();
    expect(events).toHaveLength(0);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/db/migration.js";
import { TriggerFrequencyMetric } from "../../src/metrics/trigger-frequency.js";

describe("TriggerFrequencyMetric", () => {
  let db: Database.Database;
  let metric: TriggerFrequencyMetric;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    metric = new TriggerFrequencyMetric(db);

    // Seed test data: 3 turns across 2 sessions
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, timestamp)
       VALUES ('s1', 0, datetime('now', '-1 day'))`
    ).run();
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, timestamp)
       VALUES ('s1', 1, datetime('now', '-1 day'))`
    ).run();
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, timestamp)
       VALUES ('s2', 0, datetime('now'))`
    ).run();

    // Plugin events
    db.prepare(
      `INSERT INTO plugin_events (turn_id, plugin_id, detection_method, action)
       VALUES (1, 'mem', 'tool_call', 'memory_search')`
    ).run();
    db.prepare(
      `INSERT INTO plugin_events (turn_id, plugin_id, detection_method, action)
       VALUES (2, 'mem', 'tool_call', 'memory_store')`
    ).run();
    db.prepare(
      `INSERT INTO plugin_events (turn_id, plugin_id, detection_method, action)
       VALUES (3, 'mem', 'tool_call', 'memory_search')`
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  it("should compute total trigger count", () => {
    const result = metric.compute("mem", 30);
    expect(result.totalTriggers).toBe(3);
  });

  it("should compute triggers per day", () => {
    const result = metric.compute("mem", 30);
    expect(result.triggersPerDay).toBeGreaterThan(0);
  });

  it("should compute triggers per session", () => {
    const result = metric.compute("mem", 30);
    expect(result.triggersPerSession).toBe(1.5);
  });

  it("should return daily trend data", () => {
    const result = metric.compute("mem", 30);
    expect(result.dailyTrend.length).toBeGreaterThan(0);
  });

  it("should list active plugins", () => {
    const plugins = metric.getActivePlugins(30);
    expect(plugins).toContain("mem");
  });

  it("should return zero for unknown plugin", () => {
    const result = metric.compute("unknown", 30);
    expect(result.totalTriggers).toBe(0);
  });
});

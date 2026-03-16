import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../src/db/migration.js";
import { buildReport, cleanupOldData } from "../src/engine.js";
import type { PluginInsightsConfig } from "../src/types.js";
import { DEFAULT_CONFIG } from "../src/types.js";

function makeConfig(overrides?: Partial<PluginInsightsConfig>): PluginInsightsConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

describe("buildReport", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("should return empty report when no data", () => {
    const report = buildReport(db, makeConfig(), 30);
    expect(report.plugins).toHaveLength(0);
    expect(report.periodStart).toBeTruthy();
    expect(report.periodEnd).toBeTruthy();
  });

  it("should compute report for active plugins", () => {
    // Seed data
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, timestamp, total_tokens, plugins_triggered_json)
       VALUES ('s1', 0, datetime('now'), 1000, '["mem"]')`
    ).run();
    db.prepare(
      `INSERT INTO plugin_events (turn_id, plugin_id, detection_method, action)
       VALUES (1, 'mem', 'tool_call', 'search')`
    ).run();
    db.prepare(
      `INSERT INTO plugin_installs (plugin_id, first_seen_at, last_seen_at)
       VALUES ('mem', datetime('now', '-10 days'), datetime('now'))`
    ).run();

    const report = buildReport(db, makeConfig(), 30);
    expect(report.plugins).toHaveLength(1);
    expect(report.plugins[0].pluginId).toBe("mem");
    expect(report.plugins[0].installedDays).toBeGreaterThanOrEqual(9);
    expect(report.plugins[0].verdict).toBeDefined();
    expect(report.plugins[0].triggerFrequency.totalTriggers).toBe(1);
  });

  it("should sort plugins by verdict severity", () => {
    // Plugin A: frequently used → keep
    for (let i = 0; i < 10; i++) {
      db.prepare(
        `INSERT INTO turns (session_id, turn_index, timestamp, total_tokens, plugins_triggered_json)
         VALUES ('s${i}', 0, datetime('now', '-${i} hours'), 500, '["plugA"]')`
      ).run();
      db.prepare(
        `INSERT INTO plugin_events (turn_id, plugin_id, detection_method, action)
         VALUES (${i + 1}, 'plugA', 'tool_call', 'action')`
      ).run();
    }

    // Plugin B: rarely used → low_usage
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, timestamp, total_tokens, plugins_triggered_json)
       VALUES ('sB', 0, datetime('now'), 500, '["plugB"]')`
    ).run();
    db.prepare(
      `INSERT INTO plugin_events (turn_id, plugin_id, detection_method, action)
       VALUES (11, 'plugB', 'tool_call', 'action')`
    ).run();

    const report = buildReport(db, makeConfig(), 30);
    expect(report.plugins.length).toBe(2);
    // "keep" should come before "low_usage"
    expect(report.plugins[0].verdict.level).toBe("keep");
    expect(report.plugins[1].verdict.level).toBe("low_usage");
  });
});

describe("computeVerdict (via buildReport)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("should give 'low_usage' for rarely triggered plugins", () => {
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, timestamp, plugins_triggered_json)
       VALUES ('s1', 0, datetime('now'), '["rare"]')`
    ).run();
    db.prepare(
      `INSERT INTO plugin_events (turn_id, plugin_id, detection_method, action)
       VALUES (1, 'rare', 'tool_call', 'x')`
    ).run();

    const report = buildReport(db, makeConfig(), 30);
    expect(report.plugins[0].verdict.level).toBe("low_usage");
  });

  it("should give 'keep' for frequently triggered plugins with OK metrics", () => {
    for (let i = 0; i < 20; i++) {
      db.prepare(
        `INSERT INTO turns (session_id, turn_index, timestamp, total_tokens, plugins_triggered_json)
         VALUES ('s${i}', 0, datetime('now', '-${i} hours'), 500, '["good"]')`
      ).run();
      db.prepare(
        `INSERT INTO plugin_events (turn_id, plugin_id, detection_method, action)
         VALUES (${i + 1}, 'good', 'tool_call', 'action')`
      ).run();
    }

    // Also add some baseline turns
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO turns (session_id, turn_index, timestamp, total_tokens)
         VALUES ('baseline${i}', 0, datetime('now'), 500)`
      ).run();
    }

    const report = buildReport(db, makeConfig(), 30);
    expect(report.plugins[0].verdict.level).toBe("keep");
  });
});

describe("cleanupOldData", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("should delete turns older than retention period", () => {
    // Old turn (100 days ago)
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, timestamp)
       VALUES ('old', 0, datetime('now', '-100 days'))`
    ).run();
    db.prepare(
      `INSERT INTO plugin_events (turn_id, plugin_id, detection_method, action)
       VALUES (1, 'mem', 'tool_call', 'search')`
    ).run();
    db.prepare(
      `INSERT INTO satisfaction_signals (turn_id, signal_type, confidence)
       VALUES (1, 'accepted', 0.9)`
    ).run();

    // Recent turn (1 day ago)
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, timestamp)
       VALUES ('new', 0, datetime('now', '-1 day'))`
    ).run();

    cleanupOldData(db, 90);

    const turns = db.prepare("SELECT * FROM turns").all();
    expect(turns).toHaveLength(1);
    expect((turns[0] as any).session_id).toBe("new");

    const events = db.prepare("SELECT * FROM plugin_events").all();
    expect(events).toHaveLength(0);

    const signals = db.prepare("SELECT * FROM satisfaction_signals").all();
    expect(signals).toHaveLength(0);
  });

  it("should keep all data if nothing is expired", () => {
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, timestamp)
       VALUES ('recent', 0, datetime('now'))`
    ).run();

    cleanupOldData(db, 90);

    const turns = db.prepare("SELECT * FROM turns").all();
    expect(turns).toHaveLength(1);
  });
});

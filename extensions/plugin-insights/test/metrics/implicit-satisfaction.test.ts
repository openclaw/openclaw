import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/db/migration.js";
import { ImplicitSatisfactionMetric } from "../../src/metrics/implicit-satisfaction.js";

describe("ImplicitSatisfactionMetric", () => {
  let db: Database.Database;
  let metric: ImplicitSatisfactionMetric;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    metric = new ImplicitSatisfactionMetric(db);

    // Create turns
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, timestamp) VALUES ('s1', 0, datetime('now'))`
    ).run();
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, timestamp) VALUES ('s1', 1, datetime('now'))`
    ).run();
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, timestamp) VALUES ('s1', 2, datetime('now'))`
    ).run();

    // Plugin events for turn 1 and 2
    db.prepare(
      `INSERT INTO plugin_events (turn_id, plugin_id, detection_method, action)
       VALUES (1, 'mem', 'tool_call', 'search')`
    ).run();
    db.prepare(
      `INSERT INTO plugin_events (turn_id, plugin_id, detection_method, action)
       VALUES (2, 'mem', 'tool_call', 'search')`
    ).run();

    // Satisfaction signals
    db.prepare(
      `INSERT INTO satisfaction_signals (turn_id, signal_type, confidence, next_turn_id)
       VALUES (1, 'accepted', 0.9, 2)`
    ).run();
    db.prepare(
      `INSERT INTO satisfaction_signals (turn_id, signal_type, confidence, next_turn_id)
       VALUES (2, 'retried', 0.7, 3)`
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  it("should compute acceptance rate", () => {
    const result = metric.compute("mem", 30);
    expect(result.acceptanceRate).toBe(50);
    expect(result.retryRate).toBe(50);
    expect(result.totalSignals).toBe(2);
  });

  it("should return zeros for unknown plugin", () => {
    const result = metric.compute("unknown", 30);
    expect(result.acceptanceRate).toBe(0);
    expect(result.retryRate).toBe(0);
    expect(result.totalSignals).toBe(0);
  });
});

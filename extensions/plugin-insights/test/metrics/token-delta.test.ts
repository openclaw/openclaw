import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/db/migration.js";
import { TokenDeltaMetric } from "../../src/metrics/token-delta.js";

describe("TokenDeltaMetric", () => {
  let db: Database.Database;
  let metric: TokenDeltaMetric;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    metric = new TokenDeltaMetric(db);

    // Turns WITH plugin (higher tokens)
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, timestamp, prompt_tokens, completion_tokens, total_tokens, plugins_triggered_json)
       VALUES ('s1', 0, datetime('now'), 800, 200, 1000, '["mem"]')`
    ).run();
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, timestamp, prompt_tokens, completion_tokens, total_tokens, plugins_triggered_json)
       VALUES ('s1', 1, datetime('now'), 900, 300, 1200, '["mem"]')`
    ).run();

    // Link plugin events
    db.prepare(
      `INSERT INTO plugin_events (turn_id, plugin_id, detection_method, action)
       VALUES (1, 'mem', 'tool_call', 'search')`
    ).run();
    db.prepare(
      `INSERT INTO plugin_events (turn_id, plugin_id, detection_method, action)
       VALUES (2, 'mem', 'tool_call', 'search')`
    ).run();

    // Turns WITHOUT plugin (lower tokens)
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, timestamp, prompt_tokens, completion_tokens, total_tokens)
       VALUES ('s2', 0, datetime('now'), 400, 100, 500)`
    ).run();
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, timestamp, prompt_tokens, completion_tokens, total_tokens)
       VALUES ('s2', 1, datetime('now'), 500, 100, 600)`
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  it("should compute token delta between with/without plugin", () => {
    const result = metric.compute("mem", 30);
    expect(result.avgTokensWithPlugin).toBe(1100);
    expect(result.avgTokensWithoutPlugin).toBe(550);
    expect(result.deltaTokens).toBe(550);
    expect(result.deltaPercent).toBe(100);
  });

  it("should estimate monthly cost", () => {
    const result = metric.compute("mem", 30);
    expect(result.estimatedMonthlyCostUSD).toBeGreaterThanOrEqual(0);
  });

  it("should return zero for avgTokensWithPlugin for unknown plugin", () => {
    const result = metric.compute("unknown", 30);
    expect(result.avgTokensWithPlugin).toBe(0);
    // deltaTokens will be negative since baseline exists but plugin has no triggers
    expect(result.deltaTokens).toBeLessThanOrEqual(0);
  });
});

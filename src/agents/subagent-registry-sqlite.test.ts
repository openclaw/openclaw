/**
 * Tests for subagent-registry-sqlite.ts
 *
 * Covers:
 * - markActiveSubagentRunsInterrupted with no active runs → returns 0
 * - markActiveSubagentRunsInterrupted with active runs → marks as interrupted, returns count
 * - Already-ended runs are not affected
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../infra/state-db/schema.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import {
  initSubagentRegistryTestDb,
  markActiveSubagentRunsInterrupted,
  resetSubagentRegistryDbForTest,
} from "./subagent-registry-sqlite.js";

type TestDb = ReturnType<typeof requireNodeSqlite>["DatabaseSync"]["prototype"];
let testDb: TestDb;

beforeEach(() => {
  const { DatabaseSync } = requireNodeSqlite();
  testDb = new DatabaseSync(":memory:");
  testDb.exec("PRAGMA journal_mode = WAL");
  testDb.exec("PRAGMA foreign_keys = ON");
  runMigrations(testDb);
  // Use the built-in test DB override (resolveDb() checks _dbOverride first)
  initSubagentRegistryTestDb(testDb as never);
});

afterEach(() => {
  resetSubagentRegistryDbForTest();
  try {
    testDb.close();
  } catch {
    // ignore
  }
});

// ── Helper ─────────────────────────────────────────────────────────────────

interface InsertRunOpts {
  runId: string;
  childSessionKey: string;
  requesterSessionKey?: string;
  startedAt?: number | null;
  endedAt?: number | null;
}

function insertRun(opts: InsertRunOpts): void {
  const now = Date.now();
  testDb
    .prepare(
      `INSERT INTO op1_subagent_runs (
        run_id, child_session_key, requester_session_key,
        task, created_at, started_at, ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.runId,
      opts.childSessionKey,
      opts.requesterSessionKey ?? "agent:operator1:main",
      "test task",
      now,
      opts.startedAt === undefined ? null : opts.startedAt,
      opts.endedAt === undefined ? null : opts.endedAt,
    );
}

function getRunRow(runId: string):
  | {
      ended_at: number | null;
      outcome_json: string | null;
      ended_reason: string | null;
      cleanup_completed_at: number | null;
    }
  | undefined {
  return testDb
    .prepare(
      "SELECT ended_at, outcome_json, ended_reason, cleanup_completed_at FROM op1_subagent_runs WHERE run_id = ?",
    )
    .get(runId) as
    | {
        ended_at: number | null;
        outcome_json: string | null;
        ended_reason: string | null;
        cleanup_completed_at: number | null;
      }
    | undefined;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("markActiveSubagentRunsInterrupted", () => {
  it("returns 0 when there are no active runs", () => {
    const count = markActiveSubagentRunsInterrupted("gateway-shutdown");
    expect(count).toBe(0);
  });

  it("returns 0 when only spawned (not-yet-started) runs exist", () => {
    // Spawned = started_at IS NULL → should not be marked interrupted
    insertRun({
      runId: "run-spawned",
      childSessionKey: "agent:neo:child:spawned",
      startedAt: null,
      endedAt: null,
    });

    const count = markActiveSubagentRunsInterrupted("gateway-shutdown");
    expect(count).toBe(0);

    // Row should be unchanged
    const row = getRunRow("run-spawned");
    expect(row?.ended_at).toBeNull();
    expect(row?.outcome_json).toBeNull();
  });

  it("marks active (started, not ended) runs as interrupted and returns count", () => {
    const now = Date.now();
    insertRun({
      runId: "run-active-1",
      childSessionKey: "agent:neo:child:active1",
      startedAt: now - 60_000,
      endedAt: null,
    });
    insertRun({
      runId: "run-active-2",
      childSessionKey: "agent:neo:child:active2",
      startedAt: now - 30_000,
      endedAt: null,
    });

    const count = markActiveSubagentRunsInterrupted("gateway-shutdown");
    expect(count).toBe(2);

    for (const runId of ["run-active-1", "run-active-2"]) {
      const row = getRunRow(runId);
      expect(row?.ended_at).not.toBeNull();
      expect(row?.cleanup_completed_at).not.toBeNull();

      const outcome = JSON.parse(row?.outcome_json ?? "{}") as {
        status: string;
        reason: string;
      };
      expect(outcome.status).toBe("interrupted");
      expect(outcome.reason).toBe("gateway-shutdown");
      expect(row?.ended_reason).toBe("gateway-shutdown");
    }
  });

  it("does not affect already-ended runs", () => {
    const now = Date.now();
    insertRun({
      runId: "run-ended",
      childSessionKey: "agent:neo:child:ended",
      startedAt: now - 10_000,
      endedAt: now - 5_000,
    });

    const count = markActiveSubagentRunsInterrupted("gateway-shutdown");
    expect(count).toBe(0);

    const row = getRunRow("run-ended");
    // ended_at must remain unchanged (approx now - 5000)
    expect(row?.ended_at).toBeCloseTo(now - 5_000, -2);
    expect(row?.outcome_json).toBeNull();
    expect(row?.ended_reason).toBeNull();
  });

  it("does not affect already-ended runs while also marking active ones", () => {
    const now = Date.now();
    insertRun({
      runId: "run-already-done",
      childSessionKey: "agent:neo:child:done",
      startedAt: now - 20_000,
      endedAt: now - 10_000,
    });
    insertRun({
      runId: "run-still-active",
      childSessionKey: "agent:neo:child:still",
      startedAt: now - 5_000,
      endedAt: null,
    });

    const count = markActiveSubagentRunsInterrupted("restart");
    expect(count).toBe(1);

    const doneRow = getRunRow("run-already-done");
    expect(doneRow?.outcome_json).toBeNull();

    const activeRow = getRunRow("run-still-active");
    expect(activeRow?.ended_at).not.toBeNull();
    const outcome = JSON.parse(activeRow?.outcome_json ?? "{}") as { status: string };
    expect(outcome.status).toBe("interrupted");
  });

  it("embeds the provided reason string in outcome_json", () => {
    const now = Date.now();
    insertRun({
      runId: "run-reason",
      childSessionKey: "agent:neo:child:reason",
      startedAt: now - 1_000,
      endedAt: null,
    });

    markActiveSubagentRunsInterrupted("hard-restart");

    const row = getRunRow("run-reason");
    const outcome = JSON.parse(row?.outcome_json ?? "{}") as { reason: string };
    expect(outcome.reason).toBe("hard-restart");
    expect(row?.ended_reason).toBe("hard-restart");
  });
});

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { prepareSessionMaintenancePreservation } from "../../../config/sessions/store-maintenance-preserve.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  persistRegistryFixture,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import {
  clearSubagentRunsReadCacheForTest,
  publishSubagentRunsAfterAtomicStore,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import "./subagent-registry-maintenance.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let storePath: string;

function createRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    createdAt: 1,
    task: "retained-task-marker:" + "x".repeat(32_768),
    cleanup: "keep",
    expectsCompletionMessage: true,
    execution: { status: "terminal", endedAt: 2 },
    completion: {
      required: true,
      terminalReply: { disposition: "visible", text: "retained-reply-marker" },
    },
    delivery: { status: "pending" },
    ...overrides,
  };
}

async function protectedKeys() {
  const prepared = await prepareSessionMaintenancePreservation(storePath);
  try {
    return prepared.capture().providerKeys;
  } finally {
    prepared.dispose();
  }
}

beforeEach(() => {
  const stateDir = tempDirs.make("subagent-maintenance-");
  storePath = path.join(stateDir, "sessions.json");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1");
  clearSubagentRunsReadCacheForTest();
  subagentRuns.clear();
});

afterEach(async () => {
  subagentRuns.clear();
  clearSubagentRunsReadCacheForTest();
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("subagent maintenance protection", () => {
  it("collects protection keys without decoding retained task and reply text", async () => {
    const publicRun = createRun();
    const privateRun = createRun({
      runId: "private",
      childSessionKey: "agent:main:subagent:private",
      completionTarget: "parent",
    });
    saveSubagentRegistryToSqlite(
      new Map([publicRun, privateRun].map((entry) => [entry.runId, entry])),
    );
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(await protectedKeys()).toEqual([
        publicRun.childSessionKey,
        privateRun.childSessionKey,
      ]);
      expect(
        parse.mock.calls.some(
          ([text]) =>
            text.includes("retained-task-marker:") || text.includes("retained-reply-marker"),
        ),
      ).toBe(false);
    } finally {
      parse.mockRestore();
    }
  });

  it("preserves canonical parser and protection decisions for persisted payloads", async () => {
    const run = createRun();
    saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
    const write = openOpenClawStateDatabase().db.prepare(
      "UPDATE subagent_runs SET payload_json = ? WHERE run_id = ?",
    );
    const payload = (patch: Record<string, unknown>) => JSON.stringify({ ...run, ...patch });
    const active = payload({ execution: { status: "running" } });
    const done = payload({ cleanupCompletedAt: 3, delivery: { status: "delivered" } });
    const cases: Array<[string, string, boolean]> = [
      ["active", active, true],
      ["cleanup completed", payload({ cleanupCompletedAt: 3 }), false],
      ["string cleanup", payload({ cleanupCompletedAt: "3" }), true],
      ["delivered", payload({ delivery: { status: "delivered" } }), false],
      ["in progress", payload({ delivery: { status: "in_progress" } }), true],
      ["no completion expected", payload({ expectsCompletionMessage: false }), false],
      ["pending without expectation", payload({ expectsCompletionMessage: undefined }), true],
      [
        "suspended",
        payload({
          expectsCompletionMessage: undefined,
          delivery: { status: "suspended", suspendedAt: 0 },
        }),
        true,
      ],
      [
        "suspended without timestamp",
        payload({ expectsCompletionMessage: undefined, delivery: { status: "suspended" } }),
        false,
      ],
      [
        "suspended string timestamp",
        payload({
          expectsCompletionMessage: undefined,
          delivery: { status: "suspended", suspendedAt: "1" },
        }),
        false,
      ],
      [
        "kill reconciliation after cleanup",
        payload({ cleanupCompletedAt: 3, killReconciliation: { killedAt: 0 } }),
        true,
      ],
      [
        "invalid kill reconciliation",
        payload({ cleanupCompletedAt: 3, killReconciliation: { killedAt: "0" } }),
        false,
      ],
      [
        "kill intent after cleanup",
        payload({ cleanupCompletedAt: 3, killIntent: { requestedAt: 0, reason: " stop " } }),
        true,
      ],
      [
        "invalid kill intent",
        payload({ cleanupCompletedAt: 3, killIntent: { requestedAt: 0, reason: " " } }),
        false,
      ],
      [
        "duplicate execution",
        payload({}).replace('"execution":', '"execution":{"status":"invalid"},"execution":'),
        true,
      ],
      [
        "last private envelope completed",
        `{"parentCompletion":${active.slice(0, -1)},"completionTarget":"parent"},"parentCompletion":${done.slice(0, -1)},"completionTarget":"parent"}}`,
        false,
      ],
      [
        "last private envelope active",
        `{"parentCompletion":${done.slice(0, -1)},"completionTarget":"parent"},"parentCompletion":${active.slice(0, -1)},"completionTarget":"parent"}}`,
        true,
      ],
      ["literal NUL", active + "\u0000invalid", false],
      ["malformed", "{", false],
      ["retired state", payload({ execution: undefined }), false],
      [
        "overdepth",
        active.slice(0, -1) + ',"unused":' + "[".repeat(1001) + "0" + "]".repeat(1001) + "}",
        true,
      ],
    ];
    for (const [name, text, protectedRun] of cases) {
      write.run(text, run.runId);
      clearSubagentRunsReadCacheForTest();
      expect(await protectedKeys(), name).toEqual(protectedRun ? [run.childSessionKey] : []);
    }
  });

  it("retains live overlays and acknowledged row publications", async () => {
    const run = createRun();
    saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
    expect(await protectedKeys()).toEqual([run.childSessionKey]);
    persistRegistryFixture(new Map([[run.runId, { ...run, cleanupCompletedAt: 3 }]]), [run.runId]);
    expect(await protectedKeys()).toEqual([]);
    subagentRuns.set(run.runId, run);
    expect(await protectedKeys()).toEqual([run.childSessionKey]);
    const completed = { ...run, cleanupCompletedAt: Number.NaN };
    subagentRuns.set(run.runId, completed);
    expect(await protectedKeys()).toEqual([]);
    subagentRuns.set(run.runId, {
      ...completed,
      killIntent: { requestedAt: Number.NaN, reason: "live pending intent" },
    });
    expect(await protectedKeys()).toEqual([run.childSessionKey]);
    subagentRuns.clear();
    const changed = createRun({ expectsCompletionMessage: false });
    // The runtime owner installs live rows before publishing its acknowledged write.
    subagentRuns.set(changed.runId, changed);
    persistRegistryFixture(new Map([[changed.runId, changed]]), [changed.runId]);
    expect(await protectedKeys()).toEqual([run.childSessionKey]);
    const prepared = await prepareSessionMaintenancePreservation(storePath);
    try {
      const cleaned = { ...changed, cleanupCompletedAt: 4 };
      saveSubagentRegistryToSqlite(new Map([[cleaned.runId, cleaned]]));
      subagentRuns.set(cleaned.runId, cleaned);
      publishSubagentRunsAfterAtomicStore(new Map([[cleaned.runId, cleaned]]), [cleaned.runId]);
      expect(prepared.capture().providerKeys).toEqual([]);
    } finally {
      prepared.dispose();
    }
    expect(await protectedKeys()).toEqual([]);
  });
});

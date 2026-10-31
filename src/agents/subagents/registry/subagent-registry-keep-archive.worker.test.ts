import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import * as operationAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { readChildCompletionFindings } from "../announce/subagent-announce-output.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import * as persistence from "./subagent-registry-persistence.js";
import { saveSubagentRegistryToSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "./subagent-registry-state.js";
import { createSubagentSweeperHarness } from "./subagent-registry-sweeper.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const now = Date.now();
const day = 86_400_000;
let state: OpenClawTestState;

function completed(runId: string, overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return createSubagentRunRecord({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    childAgentId: "main",
    createdAt: now - 32 * day,
    execution: { status: "terminal", endedAt: now - 31 * day, outcome: { status: "ok" } },
    cleanupCompletedAt: now - 31 * day + 1,
    completion: { required: false, resultText: `Preserved result ${runId}` },
    delivery: { status: "not_required" },
    ...overrides,
  });
}

function ids(table: "subagent_runs" | "subagent_run_archives"): string[] {
  return openOpenClawStateDatabase()
    .db.prepare(`SELECT run_id FROM ${table} ORDER BY run_id`)
    .all()
    .map((row) => String(row.run_id));
}

async function seed(entries: SubagentRunRecord[]) {
  saveSubagentRegistryToSqlite(new Map(entries.map((entry) => [entry.runId, entry])));
  await persistence.restoreSubagentRunsFromDisk({ runs: subagentRuns });
}

async function archive(at = now) {
  const { archiveCompletedSubagentRuns } = await import("./subagent-registry-archive.js");
  return archiveCompletedSubagentRuns(at);
}

beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", applyEnv: true });
  openOpenClawStateDatabase();
});
beforeEach(() => {
  vi.stubEnv("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await persistence.restoreSubagentRunsFromDisk({ runs: subagentRuns });
  const db = openOpenClawStateDatabase().db;
  // The same existing-sweeper regression runs on the archive-unaware baseline.
  const hasArchive = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("subagent_run_archives");
  const runIds = [...ids("subagent_runs"), ...(hasArchive ? ids("subagent_run_archives") : [])];
  if (runIds.length) {
    await persistence.mutateSubagentRuns(runIds, () => ({
      value: undefined,
      postimages: new Map(runIds.map((id) => [id, null])),
    }));
  }
  subagentRuns.clear();
  clearSubagentRunsReadCacheForTest();
});
afterAll(async () => state.cleanup());

it("archives completed keep history through the existing sweeper without deleting its result", async () => {
  const old = completed("swept-history");
  const session = completed("session-bookkeeping", { spawnMode: "session" });
  await seed([old, session]);
  const { sweeper, callGateway } = createSubagentSweeperHarness(old, subagentRuns);
  // Keep the real writer/receipt boundary; the harness only supplies unrelated lifecycle effects.
  vi.mocked(stateWorker.runOpenClawStateWorkerOperation).mockRestore();
  await sweeper.sweepOnce();
  expect(subagentRuns.has(old.runId)).toBe(false);
  expect(subagentRuns.has(session.runId)).toBe(false);
  expect(ids("subagent_runs")).toEqual([]);
  expect(ids("subagent_run_archives")).toEqual([old.runId]);
  const row = openOpenClawStateDatabase()
    .db.prepare("SELECT payload_json FROM subagent_run_archives WHERE run_id = ?")
    .get(old.runId);
  expect(JSON.parse(String(row?.payload_json))).toMatchObject({
    completion: { resultText: "Preserved result swept-history" },
  });
  expect(callGateway).not.toHaveBeenCalled();
});

it("keeps day-30 records and unfinished obligations until eligible, then archives once", async () => {
  const rows = [
    completed("day-30", { execution: { status: "terminal", endedAt: now - 30 * day } }),
    completed("running", { execution: { status: "running" } }),
    completed("cleanup-pending", { cleanupCompletedAt: undefined }),
    ...(["pending", "in_progress", "suspended"] as const).map((status) =>
      completed(`delivery-${status}`, { delivery: { status } }),
    ),
    completed("paused", { pauseReason: "sessions_yield" }),
    completed("requester-wake", { requesterSettleWake: { status: "pending", attemptCount: 0 } }),
    completed("requester-receipt", {
      requesterTurnRunId: "parent-turn",
      expectsCompletionMessage: true,
    }),
    completed("kill-intent", { killIntent: { requestedAt: now, reason: "operator stop" } }),
    completed("kill-reconciliation", { killReconciliation: { killedAt: now } }),
    completed("collector-cleanup", { collectorLaunchCleanupPending: true }),
    completed("eligible"),
  ];
  await seed(rows);
  expect(await archive()).toBe(1);
  expect(ids("subagent_run_archives")).toEqual(["eligible"]);
  expect([...subagentRuns.keys()].toSorted()).toEqual(
    rows
      .filter((entry) => entry.runId !== "eligible")
      .map((entry) => entry.runId)
      .toSorted(),
  );
  expect(await archive()).toBe(0);
  expect(await archive(now + 1)).toBe(1);
  expect(ids("subagent_run_archives")).toEqual(["day-30", "eligible"]);
});

it("bounds the first pass of a 10k retained backlog and preserves the remaining restart work", async () => {
  await seed(Array.from({ length: 10_000 }, (_, index) => completed(`backlog-${index}`)));
  expect(subagentRuns.size).toBe(10_000);
  expect(await archive()).toBe(128);
  expect(subagentRuns.size).toBe(9_872);
  expect(ids("subagent_run_archives")).toHaveLength(128);
  await closeOpenClawStateDatabaseAsync();
  subagentRuns.clear();
  clearSubagentRunsReadCacheForTest();
  openOpenClawStateDatabase();
  await persistence.restoreSubagentRunsFromDisk({ runs: subagentRuns });
  expect(subagentRuns.size).toBe(9_872);
  expect(await archive()).toBe(128);
  expect(ids("subagent_run_archives")).toHaveLength(256);
});

it("bounds payload bytes while admitting one oversized row for progress", async () => {
  await seed([
    completed("a-oversized", { completion: { required: false, resultText: "x".repeat(2 ** 21) } }),
    completed("b-medium", { completion: { required: false, resultText: "b".repeat(600_000) } }),
    completed("c-medium", { completion: { required: false, resultText: "c".repeat(600_000) } }),
  ]);
  expect(await archive()).toBe(1);
  expect(ids("subagent_run_archives")).toEqual(["a-oversized"]);
  expect(await archive()).toBe(1);
  expect(ids("subagent_run_archives")).toEqual(["a-oversized", "b-medium"]);
  expect(await archive()).toBe(1);
  expect(ids("subagent_runs")).toEqual([]);
});

it("rolls back archive insertion and hot deletion when commit admission is refused", async () => {
  await seed([completed("rollback")]);
  const admission = probe.admission(operationAdmission, (request, grant, admit) => {
    if (request.stage === "commit") {
      throw new Error("Synthetic retired archival owner");
    }
    admit(request, grant);
  });
  await expect(archive()).rejects.toMatchObject({
    outcome: "not-committed",
  });
  admission.mockRestore();
  expect(ids("subagent_runs")).toEqual(["rollback"]);
  expect(ids("subagent_run_archives")).toEqual([]);
  expect(subagentRuns.has("rollback")).toBe(true);
  expect(await archive()).toBe(1);
});

it("recovers committed archival after a lost reply without restoring archived records on restart", async () => {
  await seed([completed("lost-ack")]);
  const run = stateWorker.runOpenClawStateWorkerOperation;
  const transport = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementationOnce((context, operation, options) => {
      let admission: operationAdmission.SqliteWorkerOperationAdmission | undefined;
      return run(
        context,
        (scope) =>
          operation({
            execute: async (command, executeOptions) => {
              const result = await scope.execute(command, executeOptions);
              if (command.type === "subagents.persistChanges") {
                expect(admission?.committed).toBeDefined();
                Object.defineProperty(admission, "committed", { value: undefined });
                throw new SqliteWorkerError("Synthetic lost archive reply", "outcome-unknown");
              }
              return result;
            },
          }),
        {
          ...options,
          createAdmission(nativeOperation) {
            const prepared = options!.createAdmission!(nativeOperation);
            admission = prepared.admission;
            return prepared;
          },
        },
      );
    });
  await expect(archive()).rejects.toMatchObject({
    outcome: "unknown",
  });
  transport.mockRestore();
  expect(ids("subagent_runs")).toEqual([]);
  expect(ids("subagent_run_archives")).toEqual(["lost-ack"]);
  await closeOpenClawStateDatabaseAsync();
  subagentRuns.clear();
  clearSubagentRunsReadCacheForTest();
  openOpenClawStateDatabase();
  await persistence.restoreSubagentRunsFromDisk({ runs: subagentRuns });
  expect(subagentRuns.size).toBe(0);
  expect(await archive()).toBe(0);
  expect(ids("subagent_run_archives")).toEqual(["lost-ack"]);
});

it("restores only an exact follow-up generation and never resurrects explicitly deleted history", async () => {
  const selected = completed("follow-up");
  await seed([selected, completed("unrelated-history")]);
  expect(await archive()).toBe(2);
  await persistence.restoreSubagentRunForMutation(selected, captureOpenClawStateWorkerContext());
  expect([...subagentRuns.keys()]).toEqual([selected.runId]);
  expect(ids("subagent_run_archives")).toEqual(["unrelated-history"]);
  expect(ids("subagent_runs")).toEqual([selected.runId]);
  expect(await archive()).toBe(1);
  await persistence.mutateSubagentRuns([selected.runId], () => ({
    value: undefined,
    postimages: new Map([[selected.runId, null]]),
  }));
  await expect(
    persistence.restoreSubagentRunForMutation(selected, captureOpenClawStateWorkerContext()),
  ).rejects.toThrow("Archived mutation source changed");
  expect(ids("subagent_runs")).toEqual([]);
  expect(ids("subagent_run_archives")).toEqual(["unrelated-history"]);
});

it("preserves prepared completion findings across unrelated archival but rejects replacement", async () => {
  const fresh = completed("fresh-completion", {
    createdAt: now - 1_000,
    execution: { status: "terminal", endedAt: now - 500, outcome: { status: "ok" } },
    cleanupCompletedAt: now - 400,
  });
  await seed([fresh, completed("unrelated-archive")]);
  const owner = subagentRuns.get(fresh.runId)!;
  const findings = await readChildCompletionFindings([owner]);
  expect(findings.text).toContain("Preserved result fresh-completion");
  expect(findings.isCurrent()).toBe(true);
  expect(await archive()).toBe(1);
  expect(ids("subagent_run_archives")).toEqual(["unrelated-archive"]);
  expect(subagentRuns.get(fresh.runId)).toBe(owner);
  expect(findings.isCurrent()).toBe(true);

  await persistence.mutateSubagentRuns([fresh.runId], (rows) => ({
    value: undefined,
    postimages: new Map([[fresh.runId, { ...rows.get(fresh.runId)!, generation: 2 }]]),
  }));
  expect(findings.isCurrent()).toBe(false);
});

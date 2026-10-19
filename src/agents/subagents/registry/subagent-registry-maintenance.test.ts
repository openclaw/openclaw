import path from "node:path";
import { StatementSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { prepareSessionMaintenancePreservation } from "../../../config/sessions/store-maintenance-preserve.js";
import * as stateReads from "../../../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { withRestoredMocks } from "../../../test-utils/vitest-spies.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
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

function createRun(runId = "run", overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return createSubagentRunRecord({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    createdAt: 1,
    task: "retained-task-marker:" + "x".repeat(32_768),
    expectsCompletionMessage: true,
    execution: { status: "terminal", endedAt: 2 },
    completion: {
      required: true,
      terminalReply: { disposition: "visible", text: "retained-reply-marker" },
    },
    delivery: { status: "pending" },
    ...overrides,
  });
}

const rows = (...runs: SubagentRunRecord[]) => new Map(runs.map((run) => [run.runId, run]));
const save = (...runs: SubagentRunRecord[]) => saveSubagentRegistryToSqlite(rows(...runs));
const expectProtected = async (...runs: SubagentRunRecord[]) =>
  expect(await protectedKeys()).toEqual(runs.map((run) => run.childSessionKey));

const preparations: Awaited<ReturnType<typeof prepareSessionMaintenancePreservation>>[] = [];
async function prepare(native = false) {
  const prepared = await prepareSessionMaintenancePreservation(storePath, { native });
  preparations.push(prepared);
  return prepared;
}
const protectedKeys = async () => (await prepare()).capture().providerKeys;

beforeEach(() => {
  const stateDir = tempDirs.make("subagent-maintenance-");
  storePath = path.join(stateDir, "sessions.json");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1");
  clearSubagentRunsReadCacheForTest();
  subagentRuns.clear();
});

afterEach(async () => {
  for (const prepared of preparations.splice(0)) {
    prepared.dispose();
  }
  subagentRuns.clear();
  clearSubagentRunsReadCacheForTest();
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
});

it("loads protection once without decoding retained task and reply text", async () => {
  const publicRun = createRun();
  const privateRun = createRun("private", { completionTarget: "parent" });
  save(publicRun, privateRun);
  const childSessionKey = `  ${publicRun.childSessionKey}  `;
  subagentRuns.set("duplicate", createRun("duplicate", { childSessionKey }));
  subagentRuns.set("blank", { ...publicRun, runId: "blank", childSessionKey: "  " });
  const parse = vi.spyOn(JSON, "parse");
  const read = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
  await withRestoredMocks([parse, read], async () => {
    await expectProtected(publicRun, privateRun);
    await expectProtected(publicRun, privateRun);
    expect(
      read.mock.calls.filter(
        ([, command]) => command.type === "subagents.runs" && command.scope.kind === "maintenance",
      ),
    ).toHaveLength(1);
    expect(
      parse.mock.calls.some(([text]) => /retained-(?:task-marker:|reply-marker)/.test(text)),
    ).toBe(false);
  });
});

it("preserves canonical parser and protection decisions for persisted payloads", async () => {
  const run = createRun();
  save(run);
  const write = openOpenClawStateDatabase().db.prepare(
    "UPDATE subagent_runs SET payload_json = ? WHERE run_id = ?",
  );
  const payload = (patch: Record<string, unknown>) => JSON.stringify({ ...run, ...patch });
  const active = payload({ execution: { status: "running" } });
  const done = payload({ cleanupCompletedAt: 3, delivery: { status: "delivered" } });
  const suspended = (suspendedAt?: unknown) => ({
    expectsCompletionMessage: undefined,
    delivery: { status: "suspended", suspendedAt },
  });
  const cleaned = { cleanupCompletedAt: 3 };
  const killed = (killedAt: unknown) => ({ ...cleaned, killReconciliation: { killedAt } });
  const intent = (reason: string) => ({ ...cleaned, killIntent: { requestedAt: 0, reason } });
  const envelopes = (first: string, last: string) =>
    `{"parentCompletion":${first.slice(0, -1)},"completionTarget":"parent"},"parentCompletion":${last.slice(0, -1)},"completionTarget":"parent"}}`;
  const duplicate = payload({}).replace(
    '"execution":',
    '"execution":{"status":"invalid"},"execution":',
  );
  const nested = "[".repeat(1001) + "0" + "]".repeat(1001);
  const cases: Array<[string, string | Record<string, unknown>, boolean]> = [
    ["active", active, true],
    ["cleaned", { cleanupCompletedAt: 3 }, false],
    ["string cleanup", { cleanupCompletedAt: "3" }, true],
    ["delivered", { delivery: { status: "delivered" } }, false],
    ["in progress", { delivery: { status: "in_progress" } }, true],
    ["no completion", { expectsCompletionMessage: false }, false],
    ["implicit pending", { expectsCompletionMessage: undefined }, true],
    ["suspended", suspended(0), true],
    ["missing suspension time", suspended(), false],
    ["string suspension time", suspended("1"), false],
    ["kill", killed(0), true],
    ["invalid kill", killed("0"), false],
    ["kill intent", intent(" stop "), true],
    ["empty kill intent", intent(" "), false],
    ["duplicate execution", duplicate, true],
    ["last envelope done", envelopes(active, done), false],
    ["last envelope active", envelopes(done, active), true],
    ["NUL", active + "\u0000invalid", false],
    ["malformed", "{", false],
    ["retired", { execution: undefined }, false],
    ["overdepth", active.slice(0, -1) + ',"unused":' + nested + "}", true],
  ];
  for (const [name, value, keep] of cases) {
    write.run(typeof value === "string" ? value : payload(value), run.runId);
    clearSubagentRunsReadCacheForTest();
    expect(await protectedKeys(), name).toEqual(keep ? [run.childSessionKey] : []);
  }
});

it("uses committed registry writes for prepared protection without rereading SQLite", async () => {
  const first = createRun("first", { cleanupCompletedAt: 3 });
  const second = createRun("second");
  save(first, second);
  const runs = new Map<string, SubagentRunRecord>();
  const prepared = await prepare(true);
  expect(prepared.capture().providerKeys).toEqual([second.childSessionKey]);
  const change = (next: SubagentRunRecord | null) =>
    mutateSubagentRuns(
      [first.runId],
      () => ({
        value: undefined,
        postimages: new Map([[first.runId, next]]),
      }),
      { runs },
    );
  await change({ ...first, cleanupCompletedAt: undefined });
  const observation = observeSqliteReadSql(StatementSync.prototype);
  try {
    const keys = [first.childSessionKey, second.childSessionKey];
    expect(prepared.refreshCandidates([first.childSessionKey]).providerKeys).toEqual(keys);
    expect(observation.queries).toEqual([]);
  } finally {
    observation.restore();
  }
  await expectProtected(first, second);
  await change(null);
  expect(prepared.capture().providerKeys).toEqual([second.childSessionKey]);
  await expectProtected(second);
});

it("retains live overlays and acknowledged row publications", async () => {
  const run = createRun();
  save(run);
  await expectProtected(run);
  persistRegistryFixture(new Map([[run.runId, { ...run, cleanupCompletedAt: 3 }]]), [run.runId]);
  await expectProtected();
  subagentRuns.set(run.runId, run);
  await expectProtected(run);
  const completed = { ...run, cleanupCompletedAt: Number.NaN };
  subagentRuns.set(run.runId, completed);
  await expectProtected();
  subagentRuns.set(run.runId, {
    ...completed,
    killIntent: { requestedAt: Number.NaN, reason: "live pending intent" },
  });
  await expectProtected(run);
  subagentRuns.clear();
  const changed = createRun("run", { expectsCompletionMessage: false });
  // The runtime owner installs live rows before publishing its acknowledged write.
  subagentRuns.set(changed.runId, changed);
  persistRegistryFixture(new Map([[changed.runId, changed]]), [changed.runId]);
  await expectProtected(run);
  const prepared = await prepare();
  const cleaned = { ...changed, cleanupCompletedAt: 4 };
  save(cleaned);
  subagentRuns.set(cleaned.runId, cleaned);
  publishSubagentRunsAfterAtomicStore(new Map([[cleaned.runId, cleaned]]), [cleaned.runId]);
  expect(prepared.capture().providerKeys).toEqual([]);
  await expectProtected();
});

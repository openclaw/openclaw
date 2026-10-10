import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import "./subagent-registry.mocks.shared.js";
import "./subagent-registry.persistence.mocks.test-support.js";
// Preserve fixture setup before importing the registry's owners.
// oxfmt-ignore
import { useSubagentPersistenceFixture } from "./subagent-registry.persistence-fixture.test-support.js";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { callGateway } from "../../../gateway/call.js";
import * as workerCpu from "../../../infra/worker-cpu.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { holdStateDatabaseWriteTransaction } from "../../../test-utils/state-database-contention.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { registerSubagentRun } from "./subagent-registry.js";

const fixture = useSubagentPersistenceFixture();

it("keeps ordinary subagent registration responsive while a SQLite writer is held", async () => {
  await fixture.allocateStateDir();
  vi.mocked(callGateway).mockResolvedValue({ status: "pending" });
  const database = openOpenClawStateDatabase();
  const context = captureOpenClawStateWorkerContext();
  expect(context.admission.databasePath.startsWith(fixture.stateDir)).toBe(true);
  const runId = "contended-registration";
  const childSessionKey = "agent:main:subagent:contended-registration";
  // Observe native entry/return without changing SQLite's lock wait or worker protocol.
  const nativeBegin = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3));
  const preload = `
    import { DatabaseSync } from "node:sqlite";
    import { workerData } from "node:worker_threads";
    const counts = new Int32Array(workerData.testRegistrationBegin);
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql) {
      if (sql !== "BEGIN IMMEDIATE" || this.location() !== workerData.testRegistrationPath ||
          Atomics.load(counts, 0) === 0) {
        return exec.call(this, sql);
      }
      Atomics.add(counts, 1, 1);
      Atomics.notify(counts, 1);
      try { return exec.call(this, sql); }
      finally { Atomics.add(counts, 2, 1); }
    };
  `;
  const createWorker = workerCpu.createCpuTrackedWorker;
  const observeWorker = vi
    .spyOn(workerCpu, "createCpuTrackedWorker")
    .mockImplementation((filename, options) =>
      createWorker(filename, {
        ...options,
        execArgv: [
          ...(options?.execArgv ?? []),
          "--import",
          `data:text/javascript,${encodeURIComponent(preload)}`,
        ],
        workerData: {
          ...options?.workerData,
          testRegistrationPath: context.admission.databasePath,
          testRegistrationBegin: nativeBegin.buffer,
        },
      }),
    );
  let holder: ReturnType<typeof holdStateDatabaseWriteTransaction> | undefined;
  let registration: Promise<void> | undefined;
  let hostSql: ReturnType<typeof observeHostDataSql> | undefined;
  let registrationSettled = false;
  const failures: unknown[] = [];
  try {
    // Warm the real worker before the independent holder starts its existing release deadline.
    await mutateSubagentRuns(
      ["registration-worker-warmup"],
      () => ({ value: undefined, postimages: new Map([["registration-worker-warmup", null]]) }),
      { context },
    );
    holder = holdStateDatabaseWriteTransaction(context.admission.databasePath, 1_000);
    await holder.ready;
    Atomics.store(nativeBegin, 0, 1);
    hostSql = observeHostDataSql();
    registration = Promise.resolve(
      registerSubagentRun({
        runId,
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "Register while a foreign SQLite writer holds its transaction",
        cleanup: "keep",
        expectsCompletionMessage: false,
      }),
    );
    const settlement = registration.finally(() => {
      registrationSettled = true;
    });
    await Promise.race([Atomics.waitAsync(nativeBegin, 1, 0).value, settlement, holder.joined]);
    await setImmediate();
    await setImmediate();
    expect(
      Atomics.load(holder.released, 0),
      "registration must let the event loop run before the SQLite writer releases",
    ).toBe(0);
    expect(Atomics.load(nativeBegin, 1)).toBeGreaterThan(0);
    expect(Atomics.load(nativeBegin, 2)).toBe(0);
    expect(registrationSettled).toBe(false);
    expect(subagentRuns.has(runId)).toBe(false);
    expect(
      database.db.prepare("SELECT run_id FROM subagent_runs WHERE run_id = ?").get(runId),
    ).toBeUndefined();
  } catch (error) {
    failures.push(error);
  } finally {
    Atomics.store(nativeBegin, 0, 0);
    Atomics.notify(nativeBegin, 1);
    holder?.release();
    for (const result of await Promise.allSettled([registration, holder?.joined])) {
      if (result.status === "rejected" && !failures.includes(result.reason)) {
        failures.push(result.reason);
      }
    }
    try {
      // Cover the whole registration through its ACK, including any later host-side fallback.
      if (hostSql) {
        expect(
          hostSql.queries.filter((sql) =>
            /^\s*(?:BEGIN|INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(sql),
          ),
        ).toEqual([]);
      }
    } catch (error) {
      failures.push(error);
    } finally {
      hostSql?.restore();
      observeWorker.mockRestore();
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Registration responsiveness or worker settlement failed");
  }
  const durable = loadSubagentRegistryFromSqlite().get(runId);
  expect(durable).toMatchObject({ runId, childSessionKey, execution: { status: "running" } });
  expect(subagentRuns.get(runId)).toEqual(durable);
  await fixture.settle();
});

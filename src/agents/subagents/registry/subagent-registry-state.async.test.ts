import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readSqliteUserVersion } from "../../../infra/sqlite-user-version.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../../state/openclaw-state-db-async-lifecycle.js";
import * as databaseCache from "../../../state/openclaw-state-db-cache.js";
import * as stateReads from "../../../state/openclaw-state-db-readonly.js";
import { withExistingOpenClawStateSchema } from "../../../state/openclaw-state-db-schema-policy.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { requireNativeSqliteDatabase } from "../../../test-utils/native-sqlite.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { buildControlledSubagentRunsReadContext as readContext } from "./subagent-control-scope.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import {
  persistRegistryFixture as publish,
  saveSubagentRegistryToSqlite as save,
} from "./subagent-registry-state.fixture.test-support.js";
import {
  clearSubagentRunsReadCacheForTest as clearCache,
  createSubagentSessionListReadView as readView,
  getSubagentSessionListRunsSnapshotForRead as readSnapshot,
  getSubagentSessionListReadSnapshotIdentity as snapshotIdentity,
  prepareOptionalSubagentSessionListReadCache as prepareOptional,
  prepareSubagentSessionListReadCache as prepare,
  withSubagentRunReadSnapshot as withSnapshot,
  prepareSubagentRunsSnapshotForRunIds as prepareSelected,
} from "./subagent-registry-state.js";
import * as store from "./subagent-registry.store.sqlite.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", applyEnv: true });
  openOpenClawStateDatabase();
  vi.stubEnv("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1");
  clearCache();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearCache();
  await state.cleanup();
});
function snapshot() {
  return readSnapshot(new Map());
}

function record(
  runId: string,
  overrides: Omit<Parameters<typeof createSubagentRunRecord>[0], "runId"> = {},
) {
  return createSubagentRunRecord({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    completion: { required: false },
    delivery: { status: "not_required" },
    ...overrides,
  });
}
function runMap(...rows: ReturnType<typeof record>[]) {
  return new Map(rows.map((row) => [row.runId, row]));
}
function runs(model: string, runId = "one") {
  return runMap(record(runId, { model }));
}
function models(rows = snapshot()) {
  return [...rows].map(([id, row]) => `${id}:${row.model}`);
}
function cleanupFailure() {
  return new AggregateError(
    [new Error("query failed"), new Error("reader cleanup failed")],
    "read and cleanup failed",
  );
}

it.each(["maintenance", "schema"] as const)(
  "rejects resident session-list reads from an ended %s scope",
  async (kind) => {
    publish(runs("retained"));
    const identity = snapshotIdentity();
    const maintenance = createOpenClawDatabaseMaintenanceScope();
    const bind = () => {
      const prepared = readView({ env: state.env });
      expect(prepared.snapshotIdentity()).toBe(identity);
      return { current: AsyncLocalStorage.bind(snapshot), prepared };
    };
    const read =
      kind === "maintenance"
        ? maintenance.run(bind)
        : withExistingOpenClawStateSchema(
            { path: captureOpenClawStateWorkerContext().admission.databasePath },
            bind,
          );
    await maintenance.close();
    const failure = kind === "maintenance" ? "scope is closed" : "admission has ended";
    expect(read.current).toThrow(failure);
    expect(read.prepared.runs).toThrow(failure);
    await expect(read.prepared.prepare()).rejects.toThrow(failure);
    expect(snapshotIdentity()).toBe(identity);
  },
);

function holdFirstCompactRead(
  command = "subagents.sessionList",
  scopeKind?: "session",
  failure?: Error,
) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const execute = stateReads.executeExistingOpenClawStateRead;
  let held = false;
  const read = vi
    .spyOn(stateReads, "executeExistingOpenClawStateRead")
    .mockImplementation(async (...args) => {
      const result = await execute(...args);
      if (
        args[1].type === command &&
        !held &&
        (scopeKind === undefined ||
          (args[1].type === "subagents.runs" && args[1].scope.kind === scopeKind))
      ) {
        held = true;
        entered.resolve();
        await release.promise;
        if (failure) {
          throw failure;
        }
      }
      return result;
    });
  return {
    entered: entered.promise,
    release: release.resolve,
    read,
    async during<T>(reading: Promise<T>, change: () => void) {
      try {
        await entered.promise;
        change();
        release.resolve();
        return await reading;
      } finally {
        release.resolve();
        await reading.catch(() => {});
      }
    },
  };
}

it("hydrates latest controlled payloads with requester descendant topology", async () => {
  const requesterSessionKey = "agent:main:parent";
  const latest = record("latest", {
    childSessionKey: "agent:main:subagent:visible",
    requesterSessionKey,
    generation: 2,
  });
  const old = { ...latest, runId: "old", generation: 1, task: "retained historical payload" };
  const descendant = record("descendant", {
    requesterSessionKey: latest.childSessionKey,
    controllerSessionKey: latest.childSessionKey,
  });
  save(runMap(old, latest, descendant));
  const read = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");

  const context = await readContext(requesterSessionKey);

  expect(context.runs.map((entry) => entry.runId)).toEqual([latest.runId]);
  expect(context.list.pendingDescendants.get(latest.childSessionKey)).toBe(1);
  expect(context.list.childSessionsByController.get(latest.childSessionKey)).toEqual([
    descendant.childSessionKey,
  ]);
  expect(read.mock.calls.map(([, command]) => command)).toEqual([
    { type: "subagents.sessionList" },
    { type: "subagents.runs", scope: { kind: "ids", runIds: [latest.runId] } },
  ]);
  const moved = {
    ...latest,
    runId: "moved",
    generation: 3,
    requesterSessionKey: "agent:main:moved",
  };
  publish(runMap(moved), [moved.runId]);
  expect((await readContext(requesterSessionKey)).runs).toEqual([]);
});

it("captures parent and yielded-child facts after the final scoped hydration", async () => {
  const parent = record("parent", {
    pauseReason: "sessions_yield",
    endedAt: Date.now(),
  });
  const child = record("child", {
    requesterSessionKey: parent.childSessionKey,
    expectsCompletionMessage: true,
    completion: { required: true },
    delivery: { status: "pending" },
  });
  save(runMap(parent, child));
  const gate = holdFirstCompactRead("subagents.runs", "session");
  const reading = readContext(parent.requesterSessionKey);
  const context = await gate.during(reading, () => {
    const changedParent = { ...parent, task: "published during child hydration" };
    const settledChild = {
      ...child,
      execution: { status: "terminal" as const, endedAt: Date.now() },
      cleanupCompletedAt: Date.now(),
    };
    publish(runMap(changedParent, settledChild), [parent.runId, child.runId]);
  });
  expect(context.list.view.latest[0]?.task).toBe("published during child hydration");
  expect(context.list.pendingDescendants.get(parent.childSessionKey)).toBe(0);
  expect(context.list.execution.get(parent.runId)).toEqual({
    state: "waiting",
    wait: { kind: "external" },
  });
});

it("omits optional hints only for a settled unavailable read without caching an empty roster", async () => {
  openOpenClawStateDatabase().db.exec("DROP TABLE subagent_runs");
  expect(await prepareOptional()).toBe(false);
  expect(snapshotIdentity()).toBeUndefined();

  const failure = cleanupFailure();
  const read = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
  read.mockRejectedValueOnce(failure);
  await expect(prepareOptional()).rejects.toBe(failure);
  expect(snapshotIdentity()).toBeUndefined();
});

it("rejects newer schema admission before optional compact hints can be omitted", async () => {
  save(runs("retained"));
  const { db } = openOpenClawStateDatabase();
  const version = readSqliteUserVersion(requireNativeSqliteDatabase(db));
  db.exec("PRAGMA user_version = 2147483647");
  try {
    await expect(prepareOptional()).rejects.toThrow("newer schema version");
    expect(snapshotIdentity()).toBeUndefined();
  } finally {
    db.exec(`PRAGMA user_version = ${version}`);
  }
  await expect(prepareOptional()).resolves.toBe(true);
  expect(snapshot().get("one")?.model).toBe("retained");
});

it("preserves an optional read cleanup failure when its caller also cancels", async () => {
  save(runs("retained"));
  const failure = cleanupFailure();
  const gate = holdFirstCompactRead("subagents.sessionList", undefined, failure);
  const work = new AsyncWorkScope();
  const observed = work.track(prepareOptional).catch((error: unknown) => error);
  try {
    expect(await gate.during(observed, () => work.beginClose(new Error("request canceled")))).toBe(
      failure,
    );
    expect(snapshotIdentity()).toBeUndefined();
  } finally {
    await work.drain();
  }
});

it("consumes only selected full rows with current raw ownership after worker hydration", async () => {
  const retained = record("one", { swarmRunId: "collector" });
  save(runMap(retained, record("other")));
  const memory = new Map<string, typeof retained>();
  const gate = holdFirstCompactRead("subagents.runs");
  const read = prepareSelected(memory, ["collector"]);
  const prepared = await gate.during(read, () => {
    memory.set("one", { ...retained, requesterSessionKey: "agent:other:parent" });
  });
  expect(
    prepared.consume((selected) => {
      expect([...selected.keys()]).toEqual(["one"]);
      expect(selected.get("one")?.task).toBe(retained.task);
      return selected.get("one")?.requesterSessionKey;
    }),
  ).toEqual({ ready: true, value: "agent:other:parent" });
  expect(gate.read.mock.calls.map(([, command]) => command)).toEqual([
    { type: "subagents.sessionList" },
    { type: "subagents.runs", scope: { kind: "ids", runIds: ["one"] } },
  ]);
  expect(() => prepared.consume(async () => "late")).toThrow("consumers must remain synchronous");
});

it.each([
  ["update", ["changed:after", "other:retained"]],
  ["delete", ["other:retained"]],
  ["replace", ["new:replacement"]],
])(
  "retains a named %s publication while a real worker fill is pending",
  async (change, expected) => {
    save(new Map([...runs("before", "changed"), ...runs("retained", "other")]));
    const gate = holdFirstCompactRead();
    const prepared = prepare();
    await gate.during(prepared, () => {
      if (change === "replace") {
        publish(runs("replacement", "new"));
      } else {
        publish(change === "update" ? runs("after", "changed") : new Map(), ["changed"]);
      }
    });
    expect(models()).toEqual(expected);
    expect(gate.read).toHaveBeenCalledTimes(1);
  },
);

it.each(["during", "after a named publication"] as const)(
  "rechecks first database creation following an absent read (%s)",
  async (creation) => {
    await withOpenClawTestState(
      { scenario: "empty", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async () => {
        clearCache();
        const admission = captureOpenClawStateWorkerContext().admission;
        expect(admission.identity.key).toMatch(/^path:/);
        const gate = creation === "during" ? holdFirstCompactRead() : undefined;
        const prepared = prepare();
        try {
          if (gate) {
            await gate.entered;
          } else {
            await prepared;
            expect(snapshot().size).toBe(0);
          }
          save(runs("created"));
          admission.assertCurrent();
          expect(admission.identity.key).toMatch(/^file:/);
          if (creation === "after a named publication") {
            publish(runs("published", "own"), ["own"]);
          }
          gate?.release();
          await prepared;
          await prepare();
          expect(snapshot().get("one")?.model).toBe("created");
          if (creation === "after a named publication") {
            expect(snapshot().get("own")?.model).toBe("published");
          }
        } finally {
          gate?.release();
          await prepared.catch(() => {});
          clearCache();
        }
      },
    );
  },
);

it("does not install private snapshot bytes into canonical compact facts", async () => {
  save(runs("snapshot"));
  await stateReads.withOpenClawStateDatabaseReadSnapshot(async () => {
    save(runs("canonical"));
    const privateRows = await withSnapshot(
      new Map(),
      (rows) => ({ rows, runIds: [...rows.keys()], sessionKeys: [] }),
      ({ rows }) => rows,
      "all",
    );
    expect(privateRows.get("one")?.model).toBe("snapshot");
    expect(snapshotIdentity()).toBeUndefined();
  });
  await prepare();
  expect(snapshot().get("one")?.model).toBe("canonical");
});

it("keeps published compact facts through a temporary writer scope without reloading", async () => {
  const changed = record("changed", { model: "before", createdAt: 20 });
  publish(runMap(changed, record("other", { model: "retained", createdAt: 10 })));
  const initial = snapshot();
  const admission = captureOpenClawStateWorkerContext().admission;
  const load = vi.spyOn(store, "loadSubagentSessionListRunsFromSqlite");
  const observed: string[][] = [];
  const stop = subscribeSubagentRunChanges("persistence", () => observed.push(models()));
  const writer = createOpenClawDatabaseMaintenanceScope();
  try {
    writer.run(() => publish(runMap({ ...changed, model: "after" }), [changed.runId]));
    await writer.close();
    admission.assertCurrent();
    const current = snapshot();
    expect(load).not.toHaveBeenCalled();
    expect(observed).toEqual([["changed:after", "other:retained"]]);
    expect(models(current)).toEqual(["changed:after", "other:retained"]);
    expect(initial.get("changed")?.model).toBe("before");
  } finally {
    stop();
    await writer.close();
  }
});

it("keeps unrelated publication context failures visible", () => {
  const failure = new Error("synthetic context failure");
  vi.spyOn(databaseCache, "captureOpenClawStateDatabaseReadAdmission").mockImplementationOnce(
    () => {
      throw failure;
    },
  );
  expect(() => publish(runs("current"), ["one"])).toThrow(failure);
});

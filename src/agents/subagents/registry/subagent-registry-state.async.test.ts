import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
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
import {
  createOpenClawTestState,
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { buildControlledSubagentRunsReadContext } from "./subagent-control-scope.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import {
  persistRegistryFixture,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import {
  clearSubagentRunsReadCacheForTest,
  createSubagentSessionListReadView,
  getSubagentSessionListRunsSnapshotForRead,
  getSubagentSessionListReadSnapshotIdentity,
  prepareOptionalSubagentSessionListReadCache,
  prepareSubagentSessionListReadCache,
  withSubagentRunReadSnapshot,
  prepareSubagentRunsSnapshotForRunIds,
} from "./subagent-registry-state.js";
import * as store from "./subagent-registry.store.sqlite.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", applyEnv: true });
  openOpenClawStateDatabase();
  vi.stubEnv("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1");
  clearSubagentRunsReadCacheForTest();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearSubagentRunsReadCacheForTest();
  await state.cleanup();
});
function runs(model: string, runId = "one") {
  const run = createSubagentRunRecord({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    model,
    completion: { required: false },
    delivery: { status: "not_required" },
  });
  return new Map([[run.runId, run]]);
}

it("reads resident session-list facts without enumerating the process environment", () => {
  persistRegistryFixture(runs("retained"));
  const prepared = createSubagentSessionListReadView({ env: state.env });
  const preparedIdentity = prepared.snapshotIdentity();
  const originalEnv = process.env;
  let enumerations = 0;
  let identity: object | undefined;
  let model: string | undefined;
  process.env = new Proxy(originalEnv, {
    ownKeys(target) {
      enumerations++;
      return Reflect.ownKeys(target);
    },
  });
  try {
    identity = getSubagentSessionListReadSnapshotIdentity();
    model = getSubagentSessionListRunsSnapshotForRead(new Map()).get("one")?.model;
  } finally {
    process.env = originalEnv;
  }
  expect(identity).toBeDefined();
  expect(model).toBe("retained");
  expect(enumerations).toBe(0);
  const resolutions = vi.spyOn(path, "resolve");
  let current: object | undefined;
  for (let index = 0; index < 100; index++) {
    current = prepared.snapshotIdentity();
  }
  expect(current).toBe(preparedIdentity);
  expect(resolutions).not.toHaveBeenCalled();
  resolutions.mockRestore();
});

it.each(["maintenance", "schema"] as const)(
  "rejects resident session-list reads from an ended %s scope",
  async (kind) => {
    persistRegistryFixture(runs("retained"));
    const identity = getSubagentSessionListReadSnapshotIdentity();
    const maintenance = createOpenClawDatabaseMaintenanceScope();
    const bind = () => {
      const prepared = createSubagentSessionListReadView({ env: state.env });
      expect(prepared.snapshotIdentity()).toBe(identity);
      return {
        current: AsyncLocalStorage.bind(() => getSubagentSessionListRunsSnapshotForRead(new Map())),
        prepared,
      };
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
    expect(getSubagentSessionListReadSnapshotIdentity()).toBe(identity);
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
  return { entered: entered.promise, release: release.resolve, read };
}

it("prepares cold compact facts through the real read worker and keeps caller Maps private", async () => {
  const retained = runs("retained");
  retained.get("one")!.taskRunId = "logical-task";
  saveSubagentRegistryToSqlite(retained);
  const nativeLoad = vi.spyOn(store, "loadSubagentSessionListRunsFromSqlite");
  await prepareSubagentSessionListReadCache();
  const first = getSubagentSessionListRunsSnapshotForRead(new Map());
  expect(first.get("one")?.model).toBe("retained");
  expect(first.get("one")?.taskRunId).toBe("logical-task");
  first.clear();
  expect(getSubagentSessionListRunsSnapshotForRead(new Map()).get("one")?.model).toBe("retained");
  expect(nativeLoad).not.toHaveBeenCalled();
});

it.each(["requester", "controller"] as const)(
  "hydrates latest controlled payloads with %s descendant topology",
  async (owner) => {
    const requesterSessionKey = "agent:main:parent";
    const latest = createSubagentRunRecord({
      runId: "latest",
      childSessionKey: "agent:main:subagent:visible",
      requesterSessionKey,
      generation: 2,
      createdAt: Date.now(),
      completion: { required: false },
      delivery: { status: "not_required" },
    });
    const old = { ...latest, runId: "old", generation: 1, task: "retained historical payload" };
    const descendant = createSubagentRunRecord({
      runId: "descendant",
      childSessionKey: "agent:main:subagent:descendant",
      requesterSessionKey: owner === "requester" ? latest.childSessionKey : "agent:main:other",
      controllerSessionKey: latest.childSessionKey,
      createdAt: Date.now(),
      completion: { required: false },
      delivery: { status: "not_required" },
    });
    saveSubagentRegistryToSqlite(
      new Map([old, latest, descendant].map((entry) => [entry.runId, entry])),
    );
    const read = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");

    const context = await buildControlledSubagentRunsReadContext(requesterSessionKey);

    expect(context.runs.map((entry) => entry.runId)).toEqual([latest.runId]);
    expect(context.list.pendingDescendants.get(latest.childSessionKey)).toBe(
      owner === "requester" ? 1 : 0,
    );
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
    persistRegistryFixture(new Map([[moved.runId, moved]]), [moved.runId]);
    expect((await buildControlledSubagentRunsReadContext(requesterSessionKey)).runs).toEqual([]);
  },
);

it("captures parent and yielded-child facts after the final scoped hydration", async () => {
  const parent = runs("before", "parent").get("parent")!;
  parent.pauseReason = "sessions_yield";
  parent.execution = { status: "terminal", endedAt: Date.now() };
  const child = runs("child", "child").get("child")!;
  child.requesterSessionKey = parent.childSessionKey;
  child.expectsCompletionMessage = true;
  child.completion = { required: true };
  child.delivery = { status: "pending" };
  saveSubagentRegistryToSqlite(new Map([parent, child].map((entry) => [entry.runId, entry])));
  const gate = holdFirstCompactRead("subagents.runs", "session");
  const reading = buildControlledSubagentRunsReadContext(parent.requesterSessionKey);
  try {
    await gate.entered;
    const changedParent = { ...parent, task: "published during child hydration" };
    const settledChild = {
      ...child,
      execution: { status: "terminal" as const, endedAt: Date.now() },
      cleanupCompletedAt: Date.now(),
    };
    persistRegistryFixture(
      new Map([changedParent, settledChild].map((entry) => [entry.runId, entry])),
      [parent.runId, child.runId],
    );
    gate.release();
    const context = await reading;
    expect(context.list.view.latest[0]?.task).toBe("published during child hydration");
    expect(context.list.pendingDescendants.get(parent.childSessionKey)).toBe(0);
    expect(context.list.execution.get(parent.runId)).toEqual({
      state: "waiting",
      wait: { kind: "external" },
    });
  } finally {
    gate.release();
    await reading.catch(() => {});
  }
});

it("omits optional hints only for a settled unavailable read without caching an empty roster", async () => {
  openOpenClawStateDatabase().db.exec("DROP TABLE subagent_runs");
  expect(await prepareOptionalSubagentSessionListReadCache()).toBe(false);
  expect(getSubagentSessionListReadSnapshotIdentity()).toBeUndefined();

  const cleanupFailure = new AggregateError(
    [new Error("query failed"), new Error("reader cleanup failed")],
    "read and cleanup failed",
  );
  const read = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
  read.mockRejectedValueOnce(cleanupFailure);
  await expect(prepareOptionalSubagentSessionListReadCache()).rejects.toBe(cleanupFailure);
  read.mockResolvedValueOnce({ ok: true, type: "admit" });
  await expect(prepareOptionalSubagentSessionListReadCache()).rejects.toThrow(
    "Unexpected compact subagent registry read result",
  );
  expect(getSubagentSessionListReadSnapshotIdentity()).toBeUndefined();
});

it("rejects newer schema admission before optional compact hints can be omitted", async () => {
  saveSubagentRegistryToSqlite(runs("retained"));
  const { db } = openOpenClawStateDatabase();
  const version = readSqliteUserVersion(db);
  db.exec("PRAGMA user_version = 2147483647");
  try {
    await expect(prepareOptionalSubagentSessionListReadCache()).rejects.toThrow(
      "newer schema version",
    );
    expect(getSubagentSessionListReadSnapshotIdentity()).toBeUndefined();
  } finally {
    db.exec(`PRAGMA user_version = ${version}`);
  }
  await expect(prepareOptionalSubagentSessionListReadCache()).resolves.toBe(true);
  expect(getSubagentSessionListRunsSnapshotForRead(new Map()).get("one")?.model).toBe("retained");
});

it("preserves an optional read cleanup failure when its caller also cancels", async () => {
  saveSubagentRegistryToSqlite(runs("retained"));
  const failure = new AggregateError(
    [new Error("query failed"), new Error("reader cleanup failed")],
    "read and cleanup failed",
  );
  const gate = holdFirstCompactRead("subagents.sessionList", undefined, failure);
  const work = new AsyncWorkScope();
  const reading = work.track(() => prepareOptionalSubagentSessionListReadCache());
  const observed = reading.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await gate.entered;
    work.beginClose(new Error("request canceled"));
    gate.release();
    expect(await observed).toBe(failure);
    expect(getSubagentSessionListReadSnapshotIdentity()).toBeUndefined();
  } finally {
    gate.release();
    await observed;
    await work.drain();
  }
});

it("consumes only selected full rows with current raw ownership after worker hydration", async () => {
  const retained = runs("selected").get("one")!;
  retained.swarmRunId = "collector";
  saveSubagentRegistryToSqlite(
    new Map([[retained.runId, retained], ...runs("unrelated", "other")]),
  );
  const memory = new Map<string, typeof retained>();
  const gate = holdFirstCompactRead("subagents.runs");
  const read = prepareSubagentRunsSnapshotForRunIds(memory, ["collector"]);
  try {
    await gate.entered;
    memory.set("one", { ...retained, requesterSessionKey: "agent:other:parent" });
    gate.release();
    const prepared = await read;
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
  } finally {
    gate.release();
    await read.catch(() => {});
  }
});

it.each(["update", "delete", "replace"] as const)(
  "retains a named %s publication while a real worker fill is pending",
  async (change) => {
    saveSubagentRegistryToSqlite(
      new Map([...runs("before", "changed"), ...runs("retained", "other")]),
    );
    const gate = holdFirstCompactRead();
    const prepared = prepareSubagentSessionListReadCache();
    try {
      await gate.entered;
      if (change === "replace") {
        persistRegistryFixture(runs("replacement", "new"));
      } else {
        persistRegistryFixture(change === "update" ? runs("after", "changed") : new Map(), [
          "changed",
        ]);
      }
      gate.release();
      await prepared;
      const current = getSubagentSessionListRunsSnapshotForRead(new Map());
      expect([...current].map(([id, row]) => [id, row.model])).toEqual(
        change === "replace"
          ? [["new", "replacement"]]
          : change === "delete"
            ? [["other", "retained"]]
            : [
                ["changed", "after"],
                ["other", "retained"],
              ],
      );
      expect(gate.read).toHaveBeenCalledTimes(1);
    } finally {
      gate.release();
      await prepared.catch(() => {});
    }
  },
);

it.each(["after", "during", "after a named publication"] as const)(
  "rechecks first database creation following an absent read (%s)",
  async (creation) => {
    await withOpenClawTestState(
      { scenario: "empty", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async () => {
        clearSubagentRunsReadCacheForTest();
        const admission = captureOpenClawStateWorkerContext().admission;
        expect(admission.identity.key).toMatch(/^path:/);
        const gate = creation === "during" ? holdFirstCompactRead() : undefined;
        const prepared = prepareSubagentSessionListReadCache();
        try {
          if (gate) {
            await gate.entered;
          } else {
            await prepared;
            expect(getSubagentSessionListRunsSnapshotForRead(new Map()).size).toBe(0);
          }
          saveSubagentRegistryToSqlite(runs("created"));
          admission.assertCurrent();
          expect(admission.identity.key).toMatch(/^file:/);
          if (creation === "after a named publication") {
            persistRegistryFixture(runs("published", "own"), ["own"]);
          }
          gate?.release();
          await prepared;
          await prepareSubagentSessionListReadCache();
          expect(getSubagentSessionListRunsSnapshotForRead(new Map()).get("one")?.model).toBe(
            "created",
          );
          if (creation === "after a named publication") {
            expect(getSubagentSessionListRunsSnapshotForRead(new Map()).get("own")?.model).toBe(
              "published",
            );
          }
        } finally {
          gate?.release();
          await prepared.catch(() => {});
          clearSubagentRunsReadCacheForTest();
        }
      },
    );
  },
);

it("does not install private snapshot bytes into canonical compact facts", async () => {
  saveSubagentRegistryToSqlite(runs("snapshot"));
  await stateReads.withOpenClawStateDatabaseReadSnapshot(async () => {
    saveSubagentRegistryToSqlite(runs("canonical"));
    const privateRows = await withSubagentRunReadSnapshot(
      new Map(),
      (snapshot) => ({ snapshot, runIds: [...snapshot.keys()], sessionKeys: [] }),
      ({ snapshot }) => snapshot,
      "all",
    );
    expect(privateRows.get("one")?.model).toBe("snapshot");
    expect(getSubagentSessionListReadSnapshotIdentity()).toBeUndefined();
  });
  await prepareSubagentSessionListReadCache();
  expect(getSubagentSessionListRunsSnapshotForRead(new Map()).get("one")?.model).toBe("canonical");
});

it("keeps published compact facts through a temporary writer scope without reloading", async () => {
  const original = new Map([...runs("before", "changed"), ...runs("retained", "other")]);
  const changed = original.get("changed")!;
  changed.createdAt = 20;
  original.get("other")!.createdAt = 10;
  persistRegistryFixture(original);
  const initial = getSubagentSessionListRunsSnapshotForRead(new Map());
  const admission = captureOpenClawStateWorkerContext().admission;
  const load = vi.spyOn(store, "loadSubagentSessionListRunsFromSqlite");
  const observed: Array<Array<[string, string | undefined]>> = [];
  const stop = subscribeSubagentRunChanges("persistence", () => {
    observed.push(
      [...getSubagentSessionListRunsSnapshotForRead(new Map())].map(([id, row]) => [id, row.model]),
    );
  });
  const writer = createOpenClawDatabaseMaintenanceScope();
  try {
    writer.run(() =>
      persistRegistryFixture(new Map([[changed.runId, { ...changed, model: "after" }]]), [
        changed.runId,
      ]),
    );
    await writer.close();
    admission.assertCurrent();
    const current = getSubagentSessionListRunsSnapshotForRead(new Map());
    expect(load).not.toHaveBeenCalled();
    expect(observed).toEqual([
      [
        ["changed", "after"],
        ["other", "retained"],
      ],
    ]);
    expect(current.get("changed")?.model).toBe("after");
    expect(current.get("other")?.model).toBe("retained");
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
  expect(() => persistRegistryFixture(runs("current"), ["one"])).toThrow(failure);
});

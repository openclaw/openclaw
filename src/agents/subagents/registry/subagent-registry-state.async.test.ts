// Real-storage proof that committed and best-effort publications survive read-owner retirement.
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readSqliteUserVersion } from "../../../infra/sqlite-user-version.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  registerOpenClawStateDatabaseAsyncResource,
} from "../../../state/openclaw-state-db-cache.js";
import * as databaseCache from "../../../state/openclaw-state-db-cache.js";
import * as stateReads from "../../../state/openclaw-state-db-readonly.js";
import { withExistingOpenClawStateSchema } from "../../../state/openclaw-state-db-schema-policy.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { buildControlledSubagentRunsReadContext } from "./subagent-control-scope.js";
import {
  clearSubagentRunsReadCacheForTest,
  createSubagentSessionListReadView,
  getSubagentRunsSnapshotForChildSession,
  getSubagentRunsSnapshotForRead,
  getSubagentRunsSnapshotForSessions,
  getSubagentMaintenanceRunsSnapshotForRead,
  getSubagentSessionListRunsSnapshotForRead,
  getSubagentSessionListReadSnapshotIdentity,
  onSubagentRegistryPersisted,
  persistSubagentRunsToDisk,
  persistSubagentRunsToDiskOrThrow,
  prepareOptionalSubagentSessionListReadCache,
  prepareSubagentSessionListReadCache,
  publishSubagentRunsAfterAtomicStore,
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
  persistSubagentRunsToDiskOrThrow(runs("retained"));
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
    persistSubagentRunsToDiskOrThrow(runs("retained"));
    const identity = getSubagentSessionListReadSnapshotIdentity();
    const maintenance = createOpenClawDatabaseMaintenanceScope();
    const bind = () => {
      const prepared = createSubagentSessionListReadView({ env: state.env });
      expect(prepared.snapshotIdentity()).toBe(identity);
      return {
        current: AsyncLocalStorage.bind(getSubagentSessionListReadSnapshotIdentity),
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
    expect(read.prepared.snapshotIdentity).toThrow(failure);
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

it("keeps a newer source publication when a prepared projection read settles", async () => {
  store.saveSubagentRegistryToSqlite(runs("original"));
  const prepared = createSubagentSessionListReadView({ env: state.env });
  const other = await createOpenClawTestState({ scenario: "minimal", applyEnv: false });
  const gate = holdFirstCompactRead();
  const pending = prepared.prepare();
  const outcome = pending.catch((error: unknown) => error);
  let published: object | undefined;
  try {
    await gate.entered;
    await withEnvAsync({ OPENCLAW_STATE_DIR: other.stateDir }, async () => {
      persistSubagentRunsToDiskOrThrow(runs("newer source"));
      published = getSubagentSessionListReadSnapshotIdentity();
    });
    expect(prepared.snapshotIdentity()).toBeUndefined();
    gate.release();
    expect(await outcome).toMatchObject({
      message: "Subagent registry database changed during preparation",
    });
    await withEnvAsync({ OPENCLAW_STATE_DIR: other.stateDir }, async () => {
      expect(getSubagentSessionListReadSnapshotIdentity()).toBe(published);
      expect(getSubagentSessionListRunsSnapshotForRead(new Map()).get("one")?.model).toBe(
        "newer source",
      );
    });
  } finally {
    gate.release();
    await outcome;
    await other.cleanup();
  }
});

it.each(["cancel", "query failure", "cleanup failure"] as const)(
  "lets a current waiter recover only a clean canceled fill (%s)",
  async (kind) => {
    store.saveSubagentRegistryToSqlite(runs("retained"));
    const failure =
      kind === "cancel"
        ? undefined
        : kind === "query failure"
          ? new Error("synthetic query failure")
          : new AggregateError(
              [new Error("read failed"), new Error("cleanup failed")],
              "read and cleanup failed",
            );
    const reason = failure ?? new Error("first requester canceled");
    const gate = holdFirstCompactRead("subagents.sessionList", undefined, failure);
    const firstScope = new AsyncWorkScope();
    const secondScope = new AsyncWorkScope();
    const first = firstScope.track(() => prepareSubagentSessionListReadCache());
    const firstOutcome = first.then(
      () => undefined,
      (error: unknown) => error,
    );
    let second: Promise<void> | undefined;
    try {
      await gate.entered;
      second = secondScope.track(() => prepareSubagentSessionListReadCache());
      const secondOutcome = second.then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );
      // Closing with the read's own error must not relabel query or cleanup failure as cancellation.
      firstScope.beginClose(reason);
      gate.release();
      expect(await firstOutcome).toBe(reason);
      expect(await secondOutcome).toEqual(failure ? { ok: false, error: failure } : { ok: true });
      expect(gate.read).toHaveBeenCalledTimes(failure ? 1 : 2);
      if (!failure) {
        expect(getSubagentSessionListRunsSnapshotForRead(new Map()).get("one")?.model).toBe(
          "retained",
        );
      }
    } finally {
      gate.release();
      await Promise.allSettled([first, second]);
      await Promise.all([firstScope.drain(), secondScope.drain()]);
    }
  },
);

it("prepares cold compact facts through the real read worker and keeps caller Maps private", async () => {
  const retained = runs("retained");
  retained.get("one")!.taskRunId = "logical-task";
  store.saveSubagentRegistryToSqlite(retained);
  const nativeLoad = vi.spyOn(store, "loadSubagentSessionListRunsFromSqlite");
  await prepareSubagentSessionListReadCache();
  const first = getSubagentSessionListRunsSnapshotForRead(new Map());
  expect(first.get("one")?.model).toBe("retained");
  expect(first.get("one")?.taskRunId).toBe("logical-task");
  first.clear();
  expect(getSubagentSessionListRunsSnapshotForRead(new Map()).get("one")?.model).toBe("retained");
  expect(nativeLoad).not.toHaveBeenCalled();
});

it("hydrates only latest controlled payloads while counting descendants from compact facts", async () => {
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
    requesterSessionKey: latest.childSessionKey,
    createdAt: Date.now(),
    completion: { required: false },
    delivery: { status: "not_required" },
  });
  store.saveSubagentRegistryToSqlite(
    new Map([old, latest, descendant].map((entry) => [entry.runId, entry])),
  );
  const nativeLoad = vi.spyOn(store, "loadSubagentRegistryFromSqlite");
  const read = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");

  const context = await buildControlledSubagentRunsReadContext(requesterSessionKey);

  expect(context.runs.map((entry) => entry.runId)).toEqual([latest.runId]);
  expect(context.list.pendingDescendants.get(latest.childSessionKey)).toBe(1);
  expect(read.mock.calls.map(([, command]) => command)).toEqual([
    { type: "subagents.sessionList" },
    { type: "subagents.runs", scope: { kind: "ids", runIds: [latest.runId] } },
  ]);
  expect(nativeLoad).not.toHaveBeenCalled();
});

it("reselects a durable controlled generation that replaced a cached physical row", async () => {
  const previous = runs("previous", "previous").get("previous")!;
  store.saveSubagentRegistryToSqlite(new Map([[previous.runId, previous]]));
  await prepareSubagentSessionListReadCache();
  const replacement = { ...previous, runId: "replacement", generation: 2, model: "replacement" };
  store.saveSubagentRegistryToSqlite(new Map([[replacement.runId, replacement]]));
  const read = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");

  const context = await buildControlledSubagentRunsReadContext(previous.requesterSessionKey);

  expect(context.runs.map((entry) => entry.runId)).toEqual([replacement.runId]);
  expect(read.mock.calls.map(([, command]) => command)).toEqual([
    { type: "subagents.runs", scope: { kind: "ids", runIds: [previous.runId] } },
    { type: "subagents.sessionList" },
    { type: "subagents.runs", scope: { kind: "ids", runIds: [replacement.runId] } },
  ]);
});

it.each(
  (["pending", "completed"] as const).flatMap((recovery) =>
    (["child session", "run id", "collector alias", "moved collector alias"] as const).map(
      (reader) => ({ recovery, reader }),
    ),
  ),
)(
  "joins compact recovery started by another reader during payload hydration ($reader, $recovery)",
  async ({ recovery, reader }) => {
    const firstRun = runs("first", "first").get("first")!;
    firstRun.swarmRunId = "collector";
    firstRun.collect = true;
    firstRun.controllerSessionKey = "agent:main:previous-controller";
    firstRun.requesterSessionKey = "agent:main:previous-requester";
    firstRun.completion = { required: true };
    const previous = runs("previous", "previous").get("previous")!;
    store.saveSubagentRegistryToSqlite(
      new Map([firstRun, previous].map((run) => [run.runId, run])),
    );
    await prepareSubagentSessionListReadCache();

    const firstHydrated = createDeferredCore();
    const releaseFirst = createDeferredCore();
    const recoveryStarted = createDeferredCore();
    const releaseRecovery = createDeferredCore();
    const execute = stateReads.executeExistingOpenClawStateRead;
    vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementation(async (...args) => {
      const result = await execute(...args);
      const command = args[1];
      if (
        command.type === "subagents.runs" &&
        command.scope.kind === "ids" &&
        command.scope.runIds.includes(firstRun.runId)
      ) {
        firstHydrated.resolve();
        await releaseFirst.promise;
      } else if (command.type === "subagents.sessionList") {
        recoveryStarted.resolve();
        await releaseRecovery.promise;
      }
      return result;
    });
    const read = (childSessionKey: string) =>
      withSubagentRunReadSnapshot(
        new Map(),
        (snapshot) => ({
          runIds: [...snapshot.values()]
            .filter((run) => run.childSessionKey === childSessionKey)
            .map((run) => run.runId),
          sessionKeys: [],
        }),
        (selection, snapshot) => selection.runIds.map((id) => snapshot.get(id)),
      );
    const first =
      reader === "child session"
        ? read(firstRun.childSessionKey)
        : prepareSubagentRunsSnapshotForRunIds(new Map(), [
            reader === "run id" ? firstRun.runId : "collector",
          ]).then((prepared) => {
            const result = prepared.consume((selected) => [...selected.values()]);
            if (!result.ready) {
              throw new Error("Recovered selected read unexpectedly needed more preparation");
            }
            return result.value;
          });
    const firstOutcome = first.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let second: ReturnType<typeof read> | undefined;
    try {
      await firstHydrated.promise;
      const replacement = {
        ...previous,
        runId: "replacement",
        generation: 2,
        model: "replacement",
      };
      const updatedFirst = createSubagentRunRecord({
        ...firstRun,
        runId: reader === "moved collector alias" ? "moved-first" : firstRun.runId,
        model: "updated-first",
        controllerSessionKey: "agent:main:current-controller",
        requesterSessionKey: "agent:main:current-requester",
        execution: { status: "terminal", endedAt: 200 },
        completion: { required: true, resultText: "current completion", capturedAt: 200 },
        collectorCompletion: {
          status: "done",
          structured: { answer: "current result" },
          usage: { inputTokens: 13, outputTokens: 21 },
        },
      });
      store.saveSubagentRegistryToSqlite(
        new Map([updatedFirst, replacement].map((run) => [run.runId, run])),
      );
      second = read(previous.childSessionKey);
      await recoveryStarted.promise;
      if (recovery === "completed") {
        releaseRecovery.resolve();
        await second;
      }
      releaseFirst.resolve();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      releaseRecovery.resolve();

      expect(await firstOutcome).toEqual({ value: [updatedFirst] });
      await expect(second).resolves.toEqual([replacement]);
    } finally {
      releaseFirst.resolve();
      releaseRecovery.resolve();
      await Promise.allSettled([first, second]);
    }
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
  store.saveSubagentRegistryToSqlite(new Map([parent, child].map((entry) => [entry.runId, entry])));
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
    persistSubagentRunsToDiskOrThrow(
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
  store.saveSubagentRegistryToSqlite(runs("retained"));
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
  store.saveSubagentRegistryToSqlite(runs("retained"));
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
  store.saveSubagentRegistryToSqlite(
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
    store.saveSubagentRegistryToSqlite(
      new Map([...runs("before", "changed"), ...runs("retained", "other")]),
    );
    const gate = holdFirstCompactRead();
    const prepared = prepareSubagentSessionListReadCache();
    try {
      await gate.entered;
      if (change === "replace") {
        persistSubagentRunsToDiskOrThrow(runs("replacement", "new"));
      } else {
        persistSubagentRunsToDiskOrThrow(
          change === "update" ? runs("after", "changed") : new Map(),
          ["changed"],
        );
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
          store.saveSubagentRegistryToSqlite(runs("created"));
          admission.assertCurrent();
          expect(admission.identity.key).toMatch(/^file:/);
          if (creation === "after a named publication") {
            persistSubagentRunsToDiskOrThrow(runs("published", "own"), ["own"]);
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

it.each(["cancel", "retire"] as const)(
  "rejects a %s before accepting even optional worker facts",
  async (reason) => {
    store.saveSubagentRegistryToSqlite(runs("obsolete"));
    const admission = captureOpenClawStateWorkerContext().admission;
    const gate = holdFirstCompactRead();
    const work = new AsyncWorkScope();
    const prepared = work.track(() => prepareOptionalSubagentSessionListReadCache());
    const observed = prepared.then(
      () => ({ accepted: true }),
      (error: unknown) => ({ error }),
    );
    try {
      await gate.entered;
      if (reason === "cancel") {
        work.beginClose(new Error("synthetic read cancellation"));
      } else {
        await closeOpenClawStateDatabaseByPathAsync(admission.databasePath);
      }
      gate.release();
      expect(await observed).toHaveProperty("error");
      expect(getSubagentSessionListReadSnapshotIdentity()).toBeUndefined();
      gate.read.mockRestore();
      store.saveSubagentRegistryToSqlite(runs("current"));
      await prepareSubagentSessionListReadCache();
      expect(getSubagentSessionListRunsSnapshotForRead(new Map()).get("one")?.model).toBe(
        "current",
      );
    } finally {
      gate.release();
      await observed;
      await work.drain();
    }
  },
);

it("does not install private snapshot bytes into canonical compact facts", async () => {
  store.saveSubagentRegistryToSqlite(runs("snapshot"));
  await stateReads.withOpenClawStateDatabaseReadSnapshot(async () => {
    store.saveSubagentRegistryToSqlite(runs("canonical"));
    const privateRows = await withSubagentRunReadSnapshot(
      new Map(),
      (snapshot) => ({ snapshot, runIds: [...snapshot.keys()], sessionKeys: [] }),
      ({ snapshot }) => snapshot,
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
  persistSubagentRunsToDiskOrThrow(original);
  const initial = getSubagentSessionListRunsSnapshotForRead(new Map());
  const admission = captureOpenClawStateWorkerContext().admission;
  const load = vi.spyOn(store, "loadSubagentSessionListRunsFromSqlite");
  const observed: Array<Array<[string, string | undefined]>> = [];
  const stop = onSubagentRegistryPersisted(() => {
    observed.push(
      [...getSubagentSessionListRunsSnapshotForRead(new Map())].map(([id, row]) => [id, row.model]),
    );
  });
  const writer = createOpenClawDatabaseMaintenanceScope();
  try {
    writer.run(() =>
      persistSubagentRunsToDiskOrThrow(new Map([[changed.runId, { ...changed, model: "after" }]]), [
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

it.each(["best effort", "strict refusal", "strict commit", "atomic commit"])(
  "keeps %s publication independent of retired read admission",
  async (mode) => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    persistSubagentRunsToDiskOrThrow(runs("before"), ["one"]);
    const database = openOpenClawStateDatabase();
    const context = captureOpenClawStateWorkerContext();
    const current = runs("after");
    const entry = current.get("one")!;
    entry.execution = { status: "terminal", endedAt: 2, outcome: { status: "ok" } };
    entry.cleanupCompletedAt = 2;
    const wake = vi.fn();
    const unsubscribe = onSubagentRegistryPersisted(wake);
    const releaseClose = createDeferredCore();
    const unregister = registerOpenClawStateDatabaseAsyncResource({
      close: () => releaseClose.promise,
    });
    const events: Array<() => void> = [];
    const publish = () => {
      if (mode === "atomic commit") {
        publishSubagentRunsAfterAtomicStore(current, ["one"], events);
      } else if (mode === "best effort") {
        persistSubagentRunsToDisk(current, ["one"]);
      } else {
        persistSubagentRunsToDiskOrThrow(current, ["one"]);
      }
    };
    if (mode === "atomic commit") {
      store.saveSubagentRegistryChangesToSqlite(current, ["one"]);
    }
    const resumePublication = createDeferredCore();
    let publication: Promise<void> | undefined;
    if (mode === "best effort" || mode === "strict refusal") {
      const scope = createOpenClawDatabaseMaintenanceScope();
      scope.run(() => {
        publication = resumePublication.promise.then(publish);
      });
      await scope.close();
    }
    const closing = closeOpenClawStateDatabaseByPathAsync(context.admission.databasePath);
    try {
      expect(() => captureOpenClawStateWorkerContext()).toThrow("read admission is closed");
      if (publication) {
        const observed =
          mode === "strict refusal"
            ? expect(publication).rejects.toThrow("maintenance resource scope is closed")
            : expect(publication).resolves.toBeUndefined();
        resumePublication.resolve();
        await observed;
      } else {
        expect(publish).not.toThrow();
      }
      const committed = mode === "strict commit" || mode === "atomic commit";
      expect(store.readSubagentRun(database, "one")?.model).toBe(committed ? "after" : "before");
      const refused = mode === "strict refusal";
      expect(
        getSubagentRunsSnapshotForChildSession(new Map(), entry.childSessionKey).get("one"),
      ).toMatchObject({
        model: refused ? "before" : "after",
        execution: { status: refused ? "running" : "terminal" },
      });
      expect(getSubagentRunsSnapshotForRead(new Map()).get("one")).toMatchObject({
        model: refused ? "before" : "after",
        execution: { status: refused ? "running" : "terminal" },
      });
      expect(
        getSubagentRunsSnapshotForSessions(new Map(), [entry.childSessionKey]).get("one"),
      ).toMatchObject({
        model: refused ? "before" : "after",
        execution: { status: refused ? "running" : "terminal" },
      });
      const maintenance = getSubagentMaintenanceRunsSnapshotForRead(new Map()).get("one");
      expect(maintenance?.execution.status).toBe(refused ? "running" : "terminal");
      expect(maintenance?.cleanupCompletedAt).toBe(refused ? undefined : 2);
      expect(events).toHaveLength(mode === "atomic commit" ? 1 : 0);
      events.forEach((event) => event());
      expect(wake).toHaveBeenCalledTimes(refused ? 0 : 1);
    } finally {
      resumePublication.resolve();
      releaseClose.resolve();
      await closing;
      unregister();
      unsubscribe();
    }
    store.saveSubagentRegistryChangesToSqlite(runs("reopened"), ["one"]);
    await prepareSubagentSessionListReadCache();
    expect(getSubagentSessionListRunsSnapshotForRead(new Map()).get("one")?.model).toBe("reopened");
  },
);

it("keeps retired publications with their draining source across source switches and reopen", async () => {
  const selectedChild = () =>
    getSubagentRunsSnapshotForChildSession(new Map(), "agent:main:subagent:one");
  persistSubagentRunsToDiskOrThrow(runs("before"), ["one"]);
  expect(getSubagentRunsSnapshotForRead(new Map()).get("one")?.model).toBe("before");
  const context = captureOpenClawStateWorkerContext();
  const other = await createOpenClawTestState({ scenario: "minimal", applyEnv: false });
  let releaseClose = createDeferredCore();
  const unregister = registerOpenClawStateDatabaseAsyncResource({
    close: () => releaseClose.promise,
  });
  let closing = closeOpenClawStateDatabaseByPathAsync(context.admission.databasePath);
  try {
    persistSubagentRunsToDiskOrThrow(runs("after"), ["one"]);
    expect(selectedChild().get("one")?.model).toBe("after");
    expect(getSubagentRunsSnapshotForRead(new Map()).get("one")?.model).toBe("after");
    expect(
      getSubagentRunsSnapshotForSessions(new Map(), ["agent:main:subagent:one"]).get("one")?.model,
    ).toBe("after");
    await withEnvAsync({ OPENCLAW_STATE_DIR: other.stateDir }, async () => {
      expect(selectedChild().has("one")).toBe(false);
      expect(getSubagentRunsSnapshotForRead(new Map()).has("one")).toBe(false);
      persistSubagentRunsToDiskOrThrow(runs("other"), ["one"]);
    });
    expect(selectedChild().has("one")).toBe(false);
    expect(getSubagentRunsSnapshotForRead(new Map()).has("one")).toBe(false);
    persistSubagentRunsToDiskOrThrow(runs("after"), ["one"]);
    expect(selectedChild().get("one")?.model).toBe("after");
    expect(getSubagentRunsSnapshotForRead(new Map()).get("one")?.model).toBe("after");
    releaseClose.resolve();
    await closing;

    store.saveSubagentRegistryChangesToSqlite(runs("reopened"), ["one"]);
    releaseClose = createDeferredCore();
    closing = closeOpenClawStateDatabaseByPathAsync(context.admission.databasePath);
    expect(selectedChild().has("one")).toBe(false);
    expect(getSubagentRunsSnapshotForRead(new Map()).has("one")).toBe(false);
    releaseClose.resolve();
    await closing;
    expect(selectedChild().get("one")?.model).toBe("reopened");
    expect(getSubagentRunsSnapshotForRead(new Map()).get("one")?.model).toBe("reopened");
  } finally {
    releaseClose.resolve();
    await closing;
    unregister();
    await other.cleanup();
  }
});

it("keeps unrelated publication context failures visible", () => {
  const failure = new Error("synthetic context failure");
  vi.spyOn(databaseCache, "captureOpenClawStateDatabaseReadAdmission").mockImplementationOnce(
    () => {
      throw failure;
    },
  );
  expect(() => persistSubagentRunsToDisk(runs("current"), ["one"])).toThrow(failure);
});

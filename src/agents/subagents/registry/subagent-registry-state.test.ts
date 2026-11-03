import { AsyncLocalStorage } from "node:async_hooks";
// Subagent registry state tests cover hot read caching over the persisted SQLite snapshot.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSqliteUserVersion } from "../../../infra/sqlite-user-version.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../../state/openclaw-state-db-async-lifecycle.js";
import * as databaseCache from "../../../state/openclaw-state-db-cache.js";
import * as stateReads from "../../../state/openclaw-state-db-readonly.js";
import { withExistingOpenClawStateSchema } from "../../../state/openclaw-state-db-schema-policy.js";
import * as stateDatabase from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { requireNativeSqliteDatabase } from "../../../test-utils/native-sqlite.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import {
  buildControlledSubagentRunsReadContext as readContext,
  listControlledSubagentRunFacts,
} from "./subagent-control-scope.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { restoreSubagentRunsFromDisk } from "./subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import { buildSubagentRunReadIndexFromRuns } from "./subagent-registry-queries.js";
import { registerSubagentCollectorPublicationCases } from "./subagent-registry-state.collector.test-support.js";
import {
  persistRegistryFixture as publish,
  saveSubagentRegistryToSqlite as save,
} from "./subagent-registry-state.fixture.test-support.js";
import {
  clearSubagentRunsReadCacheForTest as clearCache,
  getSubagentSessionListRunsSnapshotForRead as readSnapshot,
  getSubagentSessionListRunsSnapshotForSessions as readTree,
  getSubagentRunsSnapshotForChildSession,
  getSubagentSessionListRunsSnapshotForChildSessions as readChildren,
  prepareSubagentSessionListReadCache as prepare,
  createSubagentSessionListReadView as readView,
  getSubagentSessionListReadSnapshotIdentity as snapshotIdentity,
  prepareOptionalSubagentSessionListReadCache as prepareOptional,
  withSubagentRunReadSnapshot as withSnapshot,
  prepareSubagentRunsSnapshotForRunIds as prepareSelected,
} from "./subagent-registry-state.js";
import { holdFirstCompactRead } from "./subagent-registry-state.read.test-support.js";
import { registerSubagentRestoreCacheCases } from "./subagent-registry-state.restore.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function createRun(runId: string, overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return createSubagentRunRecord({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    task: `task ${runId}`,
    createdAt: 1,
    execution: { status: "running", startedAt: 1 },
    completion: { required: false },
    delivery: { status: "pending" },
    ...overrides,
  });
}

const runMap = (...runs: SubagentRunRecord[]) => new Map(runs.map((run) => [run.runId, run]));

describe("subagent registry state", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ scenario: "minimal", applyEnv: true });
    stateDatabase.openOpenClawStateDatabase();
    vi.stubEnv("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1");
    clearCache();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    clearCache();
    vi.useRealTimers();
    await state.cleanup();
  });
  describe("read cache", () => {
    async function prepareEmptyReadCaches() {
      save(new Map());
      await restoreSubagentRunsFromDisk({ runs: new Map() });
    }
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(1_000);
      vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    });
    registerSubagentRestoreCacheCases({
      createRun,
      mockRestoredRows: save,
      refuseNextWrite: () => {
        vi.spyOn(stateDatabase, "runOpenClawStateWriteTransaction").mockImplementationOnce(() => {
          throw new Error("write refused");
        });
      },
    });

    it("keeps control selection grouped and distinguishes agents sharing a child key", async () => {
      const parent = "agent:main:parent";
      const old = createRun("old", {
        childSessionKey: "global",
        childAgentId: "main",
        requesterSessionKey: parent,
        generation: 1,
      });
      const sibling = createRun("sibling", { requesterSessionKey: parent });
      const latest = { ...old, runId: "latest", generation: 2 };
      const foreign = {
        ...old,
        runId: "foreign",
        childAgentId: "research",
        requesterSessionKey: "agent:main:other",
        generation: 3,
      };
      save(runMap(old, sibling, latest, foreign));
      await prepare();
      const read = () =>
        listControlledSubagentRunFacts(parent, "main", {}).map((entry) => entry.runId);
      expect(read()).toEqual([latest.runId, sibling.runId]);
      const controlled = { ...latest, controllerSessionKey: "agent:main:controller" };
      publish(runMap(controlled), [controlled.runId]);
      expect(read()).toEqual([latest.runId, sibling.runId]);
      expect(
        listControlledSubagentRunFacts("agent:main:controller", "main", {}).map((run) => run.runId),
      ).toEqual([latest.runId]);
      const moved = {
        ...controlled,
        controllerSessionKey: undefined,
        runId: "moved",
        requesterSessionKey: foreign.requesterSessionKey,
        generation: 4,
      };
      publish(runMap(moved), [moved.runId]);
      expect(read()).toEqual([sibling.runId]);
    });

    it("scopes compact reads while preserving owner writes and live controller moves", async () => {
      const parent = "agent:main:parent";
      const selected = createRun("selected", { controllerSessionKey: parent });
      const unrelated = createRun("unrelated");
      const runs = runMap(selected, unrelated);
      save(runs);
      await prepare();
      readSnapshot(new Map());

      expect([...readSnapshot(new Map(), [parent]).keys()]).toEqual(["selected"]);
      const moved = { ...selected, controllerSessionKey: "agent:main:other" };
      expect(readSnapshot(runMap(moved), [parent])).toEqual(new Map());

      vi.setSystemTime(1_500);
      const refreshed = { ...selected, model: "updated-model" };
      runs.set(refreshed.runId, refreshed);
      publish(runs, [refreshed.runId]);
      expect(readSnapshot(new Map(), [parent]).get("selected")?.model).toBe("updated-model");
      runs.set(refreshed.runId, { ...refreshed, controllerSessionKey: moved.controllerSessionKey });
      publish(runs, [refreshed.runId]);
      expect(readSnapshot(new Map(), [parent])).toEqual(new Map());
      expect([...readSnapshot(new Map(), [moved.controllerSessionKey]).keys()]).toEqual([
        selected.runId,
      ]);
      expect(readSnapshot(new Map(), [" "])).toEqual(new Map());
    });

    it("keeps a warm session tree scoped when a live child moves", async () => {
      await prepareEmptyReadCaches();
      const root = "agent:main:indexed-tree";
      const child = createRun("indexed-child", { requesterSessionKey: root });
      const grandchild = createRun("indexed-grandchild", {
        requesterSessionKey: child.childSessionKey,
      });
      const unrelated = createRun("indexed-unrelated");
      publish(runMap(grandchild));
      subagentRuns.set(child.runId, child);
      subagentRuns.set(unrelated.runId, unrelated);
      const read = () => [...readTree(subagentRuns, [root]).keys()];
      try {
        expect(read()).toEqual([grandchild.runId, child.runId]);
        subagentRuns.set(child.runId, { ...child, childSessionKey: "agent:main:moved" });
        expect(read()).toEqual([child.runId]);
      } finally {
        subagentRuns.delete(child.runId);
        subagentRuns.delete(unrelated.runId);
      }
    });

    it.each(["global"])(
      "retains all child generations when a newer %s requester vetoes old descendants",
      async (requesterSessionKey) => {
        await prepareEmptyReadCaches();
        const root = "agent:main:tree";
        const older = createRun("older", { requesterSessionKey: root });
        const descendant = createRun("descendant", {
          requesterSessionKey: older.childSessionKey,
        });
        const newer = createRun("newer", {
          childSessionKey: older.childSessionKey,
          requesterSessionKey,
          createdAt: 2,
          execution: { status: "running", startedAt: 2 },
        });
        publish(runMap(older, descendant, newer));

        const selected = readTree(new Map(), [root]);
        expect([...selected.keys()]).toEqual([older.runId, descendant.runId, newer.runId]);
        const index = buildSubagentRunReadIndexFromRuns({ runs: selected, now: Date.now() });
        expect(index.latestRunsByChildSessionKey.get(older.childSessionKey)?.runId).toBe(
          newer.runId,
        );
        expect(index.listDescendantRunsForRequester(root)).toEqual([]);
        expect(
          index.listDescendantRunsForRequester(requesterSessionKey).map((run) => run.runId),
        ).toEqual([newer.runId, descendant.runId]);
      },
    );

    it("keeps exact child generations current through named moves, deletion, and live overlays", async () => {
      const old = createRun("old");
      const successor = createRun("successor", {
        childSessionKey: old.childSessionKey,
        generation: 2,
        requesterSessionKey: "agent:main:other",
      });
      const unrelated = createRun("unrelated");
      save(runMap(old, successor, unrelated));
      await prepare();
      const read = () => [
        ...readChildren([`  ${old.childSessionKey}  `, old.childSessionKey, " "]).keys(),
      ];
      const listener = vi.fn();
      const stop = subscribeSubagentRunChanges("persistence", ({ sessionKeys }) =>
        listener(sessionKeys),
      );
      try {
        expect(read()).toEqual(["old", "successor"]);
        expect(readChildren([old.childSessionKey]).get("successor")?.generation).toBe(2);
        const moved = { ...successor, childSessionKey: "agent:main:moved" };
        publish(runMap(moved), [moved.runId]);
        expect(read()).toEqual(["old"]);
        expect(listener).toHaveBeenLastCalledWith(
          expect.arrayContaining([old.childSessionKey, moved.childSessionKey]),
        );
        subagentRuns.set(old.runId, { ...old, childSessionKey: moved.childSessionKey });
        expect(read()).toEqual([]);
        subagentRuns.delete(old.runId);
        publish(new Map(), [old.runId]);
        expect(read()).toEqual([]);
        publish(runMap(old));
        expect(read()).toEqual(["old"]);
        expect(listener).toHaveBeenLastCalledWith(undefined);
      } finally {
        stop();
        subagentRuns.delete(old.runId);
      }
    });

    it("requires prepared exact-child facts and keeps live moves authoritative", async () => {
      const persisted = createRun("cold-move");
      publish(runMap(persisted), [persisted.runId]);
      save(runMap(persisted));
      subagentRuns.set(persisted.runId, { ...persisted, childSessionKey: "agent:main:moved" });
      try {
        expect(readChildren([" "])).toEqual(new Map());
        expect(() => readChildren([persisted.childSessionKey])).toThrow("must be prepared");
        await prepare();
        expect(readChildren([persisted.childSessionKey])).toEqual(new Map());
        expect([...readChildren(["agent:main:moved"]).keys()]).toEqual([persisted.runId]);
      } finally {
        subagentRuns.delete(persisted.runId);
      }
    });

    it("keeps warm child lookups scoped through cache publications and live moves", async () => {
      const key = "agent:main:selected";
      const first = createRun("first", { childSessionKey: key });
      const second = createRun("second", { childSessionKey: key });
      const unrelated = createRun("unrelated");
      save(runMap(first, unrelated, second));
      await restoreSubagentRunsFromDisk({ runs: new Map() });
      const read = getSubagentRunsSnapshotForChildSession;
      expect([...(await read(new Map(), key)).keys()]).toEqual([first.runId, second.runId]);
      const retained = (await read(new Map(), key)).get(first.runId)!;
      expect(() => {
        retained.task = "caller-local change";
      }).toThrow(TypeError);
      expect((await read(new Map(), key)).get(first.runId)?.task).toBe(first.task);

      const moved = { ...first, childSessionKey: "agent:main:elsewhere" };
      publish(runMap(moved), [moved.runId]);
      expect([...(await read(new Map(), key)).keys()]).toEqual([second.runId]);
      const live = runMap(first);
      expect([...(await read(live, key)).keys()]).toEqual([second.runId, first.runId]);
      publish(runMap(first), [first.runId]);
      expect([...(await read(new Map(), key)).keys()]).toEqual([first.runId, second.runId]);
      const movedLive = runMap({ ...first, childSessionKey: "agent:main:elsewhere" });
      expect([...(await read(movedLive, key)).keys()]).toEqual([second.runId]);
      publish(new Map(), [first.runId]);
      publish(runMap(first), [first.runId]);
      expect([...(await read(new Map(), key)).keys()]).toEqual([second.runId, first.runId]);
    });

    registerSubagentCollectorPublicationCases({
      createRun,
      mockRestoredRows: save,
    });
  });
  describe("worker snapshots", () => {
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

      const context = await readContext(requesterSessionKey);

      expect(context.runs.map((entry) => entry.runId)).toEqual([latest.runId]);
      expect(context.list.pendingDescendants.get(latest.childSessionKey)).toBe(1);
      expect(context.list.childSessionsByController.get(latest.childSessionKey)).toEqual([
        descendant.childSessionKey,
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
      stateDatabase.openOpenClawStateDatabase().db.exec("DROP TABLE subagent_runs");
      expect(await prepareOptional()).toBe(false);
      expect(snapshotIdentity()).toBeUndefined();

      const failure = cleanupFailure();
      vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockRejectedValueOnce(failure);
      await expect(prepareOptional()).rejects.toBe(failure);
      expect(snapshotIdentity()).toBeUndefined();
    });

    it("rejects newer schema admission before optional compact hints can be omitted", async () => {
      save(runs("retained"));
      const { db } = stateDatabase.openOpenClawStateDatabase();
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
        expect(
          await gate.during(observed, () => work.beginClose(new Error("request canceled"))),
        ).toBe(failure);
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
      expect(() => prepared.consume(async () => "late")).toThrow(
        "consumers must remain synchronous",
      );
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
      const observed: string[][] = [];
      const stop = subscribeSubagentRunChanges("persistence", () => observed.push(models()));
      const writer = createOpenClawDatabaseMaintenanceScope();
      try {
        writer.run(() => publish(runMap({ ...changed, model: "after" }), [changed.runId]));
        await writer.close();
        admission.assertCurrent();
        const current = snapshot();
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
  });
});

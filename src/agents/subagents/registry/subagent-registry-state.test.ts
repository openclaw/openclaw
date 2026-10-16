// Subagent registry state tests cover hot read caching over the persisted SQLite snapshot.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as stateReads from "../../../state/openclaw-state-db-readonly.js";
import { listControlledSubagentRunFacts } from "./subagent-control-scope.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { restoreSubagentRunsFromDisk } from "./subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import { buildSubagentRunReadIndexFromRuns } from "./subagent-registry-queries.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import { registerSubagentCollectorPublicationCases } from "./subagent-registry-state.collector.test-support.js";
import { persistRegistryFixture } from "./subagent-registry-state.fixture.test-support.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentSessionListRunsSnapshotForRead,
  getSubagentSessionListRunsSnapshotForSessions,
  getSubagentRunsSnapshotForChildSession,
  getSubagentSessionListRunsSnapshotForChildSessions,
  prepareSubagentRunsSnapshotForRunIds,
  prepareSubagentSessionListReadCache,
  publishSubagentRunsAfterAtomicStore,
} from "./subagent-registry-state.js";
import { registerSubagentRestoreCacheCases } from "./subagent-registry-state.restore.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { copySubagentRunRuntimeOwner } from "./subagent-run-generation.js";

const mocks = vi.hoisted(() => ({
  loadSubagentRunsForChildSessionFromSqlite:
    vi.fn<(childSessionKey: string) => SubagentRunRecord[]>(),
  readRunsByIds: vi.fn<(runIds: readonly string[]) => SubagentRunRecord[]>(),
  loadSubagentRegistryFromSqlite: vi.fn<() => Map<string, SubagentRunRecord>>(),
  readCompactRuns: vi.fn<() => Map<string, SubagentRunReadRecord>>(),
  nativeCompactRead: vi.fn<() => Map<string, SubagentRunReadRecord>>(),
  saveSubagentRegistryToSqlite: vi.fn<(runs: Map<string, SubagentRunRecord>) => void>(),
  saveSubagentRegistryChangesToSqlite:
    vi.fn<(runs: Map<string, SubagentRunRecord>, changedRunIds: readonly string[]) => void>(),
}));

// mock-isolation: Keep native store access behind this cache fixture's worker replies.
vi.mock("./subagent-registry.store.sqlite.js", () => ({
  loadSubagentRunsForChildSessionFromSqlite: mocks.loadSubagentRunsForChildSessionFromSqlite,
  loadSubagentSessionListRunsFromSqlite: mocks.nativeCompactRead,
}));

vi.mock("./subagent-registry-state.fixture.test-support.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagent-registry-state.fixture.test-support.js")>()),
  saveSubagentRegistryChangesToSqlite: mocks.saveSubagentRegistryChangesToSqlite,
  saveSubagentRegistryToSqlite: mocks.saveSubagentRegistryToSqlite,
  persistRegistryFixture: (runs: Map<string, SubagentRunRecord>, runIds?: readonly string[]) => {
    if (runIds) {
      mocks.saveSubagentRegistryChangesToSqlite(runs, runIds);
    } else {
      mocks.saveSubagentRegistryToSqlite(runs);
    }

    const published = new Map(runs);
    for (const id of runIds ?? runs.keys()) {
      const entry = runs.get(id);
      if (entry) {
        published.set(id, copySubagentRunRuntimeOwner(entry, structuredClone(entry)));
      }
    }
    publishSubagentRunsAfterAtomicStore(published, runIds)();
  },
}));

function createRun(runId: string): SubagentRunRecord {
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: `task ${runId}`,
    cleanup: "keep",
    createdAt: 1,
    execution: { status: "running", startedAt: 1 },
    completion: { required: false },
    delivery: { status: "pending" },
  };
}

describe("subagent registry state read cache", () => {
  const previousReadSqliteFlag = process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE;

  async function prepareEmptyReadCaches() {
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(new Map());
    await restoreSubagentRunsFromDisk({ runs: new Map() });
    mocks.loadSubagentRegistryFromSqlite.mockClear();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE = "1";
    clearSubagentRunsReadCacheForTest();
    mocks.loadSubagentRunsForChildSessionFromSqlite.mockReset();
    mocks.readRunsByIds.mockReset();
    mocks.loadSubagentRegistryFromSqlite.mockReset();
    mocks.readCompactRuns.mockReset();
    mocks.nativeCompactRead.mockReset().mockImplementation(() => {
      throw new Error("Compact registry reads must use the read worker");
    });
    mocks.saveSubagentRegistryChangesToSqlite.mockReset();
    mocks.saveSubagentRegistryToSqlite.mockReset();
    vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementation(
      async (_options, command, options) => {
        if (command.type === "subagents.sessionList") {
          return {
            ok: true,
            type: command.type,
            sourceAdmitted: true,
            runs: mocks.readCompactRuns(),
          };
        }
        if (command.type === "subagents.runs" && command.scope.kind === "ids") {
          return {
            ok: true,
            type: command.type,
            sourceAdmitted: true,
            runs: new Map(mocks.readRunsByIds(command.scope.runIds).map((run) => [run.runId, run])),
          };
        }
        if (command.type === "subagents.restore") {
          const runs = mocks.loadSubagentRegistryFromSqlite();
          options?.onChunk?.(
            [...runs.values()].map((entry) => ({
              entry,
              createdAt: entry.createdAt,
            })),
          );
          return { ok: true, type: command.type, sourceAdmitted: true, count: runs.size };
        }
        throw new Error(`Unexpected registry read: ${command.type}`);
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearSubagentRunsReadCacheForTest();
    if (previousReadSqliteFlag === undefined) {
      delete process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE;
    } else {
      process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE = previousReadSqliteFlag;
    }
    vi.useRealTimers();
    expect(mocks.nativeCompactRead).not.toHaveBeenCalled();
  });

  registerSubagentRestoreCacheCases({
    createRun,
    mockRestoredRows: (runs) => {
      mocks.loadSubagentRegistryFromSqlite.mockReturnValue(runs);
      mocks.readCompactRuns.mockReturnValue(runs);
    },
    refuseNextWrite: () => {
      mocks.saveSubagentRegistryChangesToSqlite.mockImplementationOnce(() => {
        throw new Error("write refused");
      });
    },
  });

  it("bounds durable control reads and keeps requester visibility across controller moves", async () => {
    const parent = "agent:main:parent";
    const selected = { ...createRun("selected"), requesterSessionKey: parent };
    const runs = new Map(
      Array.from({ length: 5_000 }, (_, index) => {
        const entry = createRun(`other-${index}`);
        return [entry.runId, entry] as const;
      }),
    );
    runs.set(selected.runId, selected);
    mocks.readCompactRuns.mockReturnValue(runs);
    await prepareSubagentSessionListReadCache();
    const read = () => listControlledSubagentRunFacts(parent, "main", {});
    expect(read().map((entry) => entry.runId)).toEqual([selected.runId]);
    const scan = vi.spyOn(runs, "values");
    const iterate = vi.spyOn(runs, Symbol.iterator);
    const moved = { ...selected, controllerSessionKey: "agent:main:controller" };
    persistRegistryFixture(new Map([[moved.runId, moved]]), [moved.runId]);
    expect(read().map((entry) => entry.runId)).toEqual([selected.runId]);
    expect(
      listControlledSubagentRunFacts("agent:main:controller", "main", {}).map(
        (entry) => entry.runId,
      ),
    ).toEqual([selected.runId]);
    const replacement = {
      ...moved,
      runId: "replacement",
      generation: 2,
      requesterSessionKey: "agent:main:other",
      controllerSessionKey: "agent:main:other",
    };
    persistRegistryFixture(new Map([[replacement.runId, replacement]]), [replacement.runId]);
    expect(read()).toEqual([]);
    expect(scan).not.toHaveBeenCalled();
    expect(iterate).not.toHaveBeenCalled();
  });

  it("scopes compact reads while preserving owner writes and live controller moves", async () => {
    const parent = "agent:main:parent";
    const selected = { ...createRun("selected"), controllerSessionKey: parent };
    const unrelated = createRun("unrelated");
    const runs = new Map([selected, unrelated].map((entry) => [entry.runId, entry]));
    mocks.readCompactRuns.mockReturnValueOnce(new Map(runs));
    await prepareSubagentSessionListReadCache();
    getSubagentSessionListRunsSnapshotForRead(new Map());

    expect([...getSubagentSessionListRunsSnapshotForRead(new Map(), [parent]).keys()]).toEqual([
      "selected",
    ]);
    expect(mocks.readCompactRuns).toHaveBeenCalledOnce();
    const moved = { ...selected, controllerSessionKey: "agent:main:other" };
    expect(
      getSubagentSessionListRunsSnapshotForRead(new Map([[moved.runId, moved]]), [parent]),
    ).toEqual(new Map());

    vi.advanceTimersByTime(500);
    const refreshed = { ...selected, model: "updated-model" };
    runs.set(refreshed.runId, refreshed);
    persistRegistryFixture(runs, [refreshed.runId]);
    expect(
      getSubagentSessionListRunsSnapshotForRead(new Map(), [parent]).get("selected")?.model,
    ).toBe("updated-model");
    runs.set(refreshed.runId, { ...refreshed, controllerSessionKey: moved.controllerSessionKey });
    persistRegistryFixture(runs, [refreshed.runId]);
    expect(getSubagentSessionListRunsSnapshotForRead(new Map(), [parent])).toEqual(new Map());
    expect([
      ...getSubagentSessionListRunsSnapshotForRead(new Map(), [moved.controllerSessionKey]).keys(),
    ]).toEqual([selected.runId]);
    expect(mocks.readCompactRuns).toHaveBeenCalledOnce();
    expect(getSubagentSessionListRunsSnapshotForRead(new Map(), [" "])).toEqual(new Map());
  });

  it("reads a warm session tree without enumerating unrelated live runs", async () => {
    await prepareEmptyReadCaches();
    const root = "agent:main:indexed-tree";
    const child = { ...createRun("indexed-child"), requesterSessionKey: root };
    const grandchild = {
      ...createRun("indexed-grandchild"),
      requesterSessionKey: child.childSessionKey,
    };
    const unrelated = createRun("indexed-unrelated");
    persistRegistryFixture(new Map([[grandchild.runId, grandchild]]));
    subagentRuns.set(child.runId, child);
    subagentRuns.set(unrelated.runId, unrelated);
    const read = () => [
      ...getSubagentSessionListRunsSnapshotForSessions(subagentRuns, [root]).keys(),
    ];
    try {
      expect(read()).toEqual([grandchild.runId, child.runId]);
      const projection = getSubagentSessionListRunsSnapshotForSessions(subagentRuns, [root]).get(
        child.runId,
      );
      expect(getSubagentSessionListRunsSnapshotForRead(subagentRuns).get(child.runId)).toBe(
        projection,
      );
      const values = vi.spyOn(subagentRuns, "values");
      const entries = vi.spyOn(subagentRuns, Symbol.iterator);
      expect(read()).toEqual([grandchild.runId, child.runId]);
      subagentRuns.set(child.runId, { ...child, childSessionKey: "agent:main:moved" });
      expect(read()).toEqual([child.runId]);
      expect(
        getSubagentSessionListRunsSnapshotForSessions(subagentRuns, [root]).get(child.runId),
      ).not.toBe(projection);
      expect(values).not.toHaveBeenCalled();
      expect(entries).not.toHaveBeenCalled();
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
      const older = { ...createRun("older"), requesterSessionKey: root };
      const descendant = { ...createRun("descendant"), requesterSessionKey: older.childSessionKey };
      const newer = {
        ...createRun("newer"),
        childSessionKey: older.childSessionKey,
        requesterSessionKey,
        createdAt: 2,
        execution: { status: "running" as const, startedAt: 2 },
      };
      persistRegistryFixture(new Map([older, descendant, newer].map((run) => [run.runId, run])));

      const selected = getSubagentSessionListRunsSnapshotForSessions(new Map(), [root]);
      expect([...selected.keys()]).toEqual([older.runId, descendant.runId, newer.runId]);
      const index = buildSubagentRunReadIndexFromRuns({ runs: selected, now: Date.now() });
      expect(index.latestRunsByChildSessionKey.get(older.childSessionKey)?.runId).toBe(newer.runId);
      expect(index.listDescendantRunsForRequester(root)).toEqual([]);
      expect(
        index.listDescendantRunsForRequester(requesterSessionKey).map((run) => run.runId),
      ).toEqual([newer.runId, descendant.runId]);
    },
  );

  it("keeps exact child generations current through named moves, deletion, and live overlays", async () => {
    const old = createRun("old");
    const successor = {
      ...createRun("successor"),
      childSessionKey: old.childSessionKey,
      generation: 2,
      requesterSessionKey: "agent:main:other",
    };
    const unrelated = createRun("unrelated");
    mocks.readCompactRuns.mockReturnValue(
      new Map([old, successor, unrelated].map((run) => [run.runId, run])),
    );
    await prepareSubagentSessionListReadCache();
    const read = () => [
      ...getSubagentSessionListRunsSnapshotForChildSessions([
        `  ${old.childSessionKey}  `,
        old.childSessionKey,
        " ",
      ]).keys(),
    ];
    const listener = vi.fn();
    const stop = subscribeSubagentRunChanges("persistence", ({ sessionKeys }) =>
      listener(sessionKeys),
    );
    try {
      expect(read()).toEqual(["old", "successor"]);
      expect(
        getSubagentSessionListRunsSnapshotForChildSessions([old.childSessionKey]).get("successor")
          ?.generation,
      ).toBe(2);
      const moved = { ...successor, childSessionKey: "agent:main:moved" };
      persistRegistryFixture(new Map([[moved.runId, moved]]), [moved.runId]);
      expect(read()).toEqual(["old"]);
      expect(listener).toHaveBeenLastCalledWith(
        expect.arrayContaining([old.childSessionKey, moved.childSessionKey]),
      );
      subagentRuns.set(old.runId, { ...old, childSessionKey: moved.childSessionKey });
      expect(read()).toEqual([]);
      subagentRuns.delete(old.runId);
      persistRegistryFixture(new Map(), [old.runId]);
      expect(read()).toEqual([]);
      expect(mocks.readCompactRuns).toHaveBeenCalledOnce();
      expect(mocks.loadSubagentRegistryFromSqlite).not.toHaveBeenCalled();
      persistRegistryFixture(new Map([[old.runId, old]]));
      expect(read()).toEqual(["old"]);
      expect(listener).toHaveBeenLastCalledWith(undefined);
    } finally {
      stop();
      subagentRuns.delete(old.runId);
    }
  });

  it("requires prepared exact-child facts and keeps live moves authoritative", async () => {
    const persisted = createRun("cold-move");
    persistRegistryFixture(new Map([[persisted.runId, persisted]]), [persisted.runId]);
    mocks.readCompactRuns.mockReturnValue(new Map([[persisted.runId, persisted]]));
    subagentRuns.set(persisted.runId, { ...persisted, childSessionKey: "agent:main:moved" });
    try {
      expect(getSubagentSessionListRunsSnapshotForChildSessions([" "])).toEqual(new Map());
      expect(() =>
        getSubagentSessionListRunsSnapshotForChildSessions([persisted.childSessionKey]),
      ).toThrow("must be prepared");
      await prepareSubagentSessionListReadCache();
      expect(
        getSubagentSessionListRunsSnapshotForChildSessions([persisted.childSessionKey]),
      ).toEqual(new Map());
      expect([
        ...getSubagentSessionListRunsSnapshotForChildSessions(["agent:main:moved"]).keys(),
      ]).toEqual([persisted.runId]);
      expect(mocks.loadSubagentRegistryFromSqlite).not.toHaveBeenCalled();
    } finally {
      subagentRuns.delete(persisted.runId);
    }
  });

  it("keeps warm child lookups scoped through cache publications and live moves", async () => {
    const key = "agent:main:selected";
    const first = {
      ...createRun("first"),
      childSessionKey: key,
    };
    const second = {
      ...createRun("second"),
      childSessionKey: key,
    };
    const unrelated = createRun("unrelated");
    const field = "childSessionKey";
    const original = unrelated[field];
    let unrelatedReads = 0;
    Object.defineProperty(unrelated, field, {
      enumerable: true,
      get() {
        unrelatedReads++;
        return original;
      },
    });
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(
      new Map([first, unrelated, second].map((run) => [run.runId, run])),
    );
    await restoreSubagentRunsFromDisk({ runs: new Map() });
    const read = getSubagentRunsSnapshotForChildSession;
    expect([...(await read(new Map(), key)).keys()]).toEqual([first.runId, second.runId]);
    unrelatedReads = 0;
    const retained = (await read(new Map(), key)).get(first.runId)!;
    expect(() => {
      retained.task = "caller-local change";
    }).toThrow(TypeError);
    expect((await read(new Map(), key)).get(first.runId)).toBe(retained);
    expect((await read(new Map(), key)).get(first.runId)?.task).toBe(first.task);

    const moved = { ...first, [field]: "agent:main:elsewhere" };
    persistRegistryFixture(new Map([[moved.runId, moved]]), [moved.runId]);
    expect([...(await read(new Map(), key)).keys()]).toEqual([second.runId]);
    const live = new Map([[first.runId, first]]);
    expect([...(await read(live, key)).keys()]).toEqual([second.runId, first.runId]);
    expect((await read(live, key)).get(first.runId)).toBe(first);

    persistRegistryFixture(new Map([[first.runId, first]]), [first.runId]);
    expect([...(await read(new Map(), key)).keys()]).toEqual([first.runId, second.runId]);
    persistRegistryFixture(new Map(), [first.runId]);
    persistRegistryFixture(new Map([[first.runId, first]]), [first.runId]);
    expect([...(await read(new Map(), key)).keys()]).toEqual([second.runId, first.runId]);
    expect(unrelatedReads).toBe(0);
    expect(mocks.loadSubagentRegistryFromSqlite).toHaveBeenCalledOnce();
    expect(mocks.loadSubagentRunsForChildSessionFromSqlite).not.toHaveBeenCalled();
  });

  it("masks persisted scope membership when the live run moved", async () => {
    const persisted = createRun("moved");
    persisted.controllerSessionKey = "agent:main:controller:old";
    persisted.childSessionKey = "agent:main:subagent:old";
    const inMemory = {
      ...persisted,
      controllerSessionKey: "agent:main:controller:new",
      childSessionKey: "agent:main:subagent:new",
    };
    mocks.readCompactRuns.mockReturnValue(new Map([[persisted.runId, persisted]]));
    mocks.readRunsByIds.mockImplementation(() => [structuredClone(persisted)]);
    const live = new Map([[inMemory.runId, inMemory]]);

    expect(await getSubagentRunsSnapshotForChildSession(live, "agent:main:subagent:old")).toEqual(
      new Map(),
    );
  });

  it("shares the compact read cache while hydrating only known physical run ids", async () => {
    const selected = { ...createRun("selected"), swarmRunId: "collector" };
    const unrelated = createRun("unrelated");
    mocks.readCompactRuns.mockReturnValue(
      new Map([
        [selected.runId, selected],
        [unrelated.runId, unrelated],
      ]),
    );
    mocks.readRunsByIds.mockReturnValue([structuredClone(selected)]);
    await prepareSubagentSessionListReadCache();
    getSubagentSessionListRunsSnapshotForRead(new Map());

    const prepared = await prepareSubagentRunsSnapshotForRunIds(new Map(), ["collector"]);
    expect(
      prepared.consume((runs) => {
        expect([...runs.keys()]).toEqual(["selected"]);
      }),
    ).toEqual({ ready: true, value: undefined });
    expect(mocks.readRunsByIds).toHaveBeenCalledExactlyOnceWith(["selected"]);
    expect(mocks.readCompactRuns).toHaveBeenCalledOnce();
    expect(mocks.loadSubagentRegistryFromSqlite).not.toHaveBeenCalled();
  });

  registerSubagentCollectorPublicationCases({
    createRun,
    mockRestoredRows: (runs) => mocks.loadSubagentRegistryFromSqlite.mockReturnValue(runs),
  });
});

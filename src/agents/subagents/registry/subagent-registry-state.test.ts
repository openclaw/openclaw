// Subagent registry state tests cover hot read caching over the persisted SQLite snapshot.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as stateReads from "../../../state/openclaw-state-db-readonly.js";
import { listControlledSubagentRunFacts } from "./subagent-control-scope.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { restoreSubagentRunsFromDisk } from "./subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import { buildSubagentRunReadIndexFromRuns } from "./subagent-registry-queries.js";
import * as readTopology from "./subagent-registry-read-topology.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import { registerSubagentCollectorPublicationCases } from "./subagent-registry-state.collector.test-support.js";
import { persistRegistryFixture } from "./subagent-registry-state.fixture.test-support.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentSessionListRunsSnapshotForRead as readSnapshot,
  getSubagentSessionListRunsSnapshotForSessions as readTree,
  getSubagentRunsSnapshotForChildSession,
  getSubagentSessionListRunsSnapshotForChildSessions as readChildren,
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

const runMap = (...runs: SubagentRunRecord[]) => new Map(runs.map((run) => [run.runId, run]));

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
    const topology = vi.spyOn(readTopology, "buildSubagentRunReadTopology");
    const read = () => listControlledSubagentRunFacts(parent, "main", {});
    expect(read().map((entry) => entry.runId)).toEqual([selected.runId]);
    const scan = vi.spyOn(runs, "values");
    const iterate = vi.spyOn(runs, Symbol.iterator);
    const moved = { ...selected, controllerSessionKey: "agent:main:controller" };
    persistRegistryFixture(runMap(moved), [moved.runId]);
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
    persistRegistryFixture(runMap(replacement), [replacement.runId]);
    expect(read()).toEqual([]);
    expect(scan).not.toHaveBeenCalled();
    expect(iterate).not.toHaveBeenCalled();
    expect(topology).not.toHaveBeenCalled();
  });

  it("keeps control selection grouped and distinguishes agents sharing a child key", async () => {
    const parent = "agent:main:parent";
    const old = {
      ...createRun("old"),
      childSessionKey: "global",
      childAgentId: "main",
      requesterSessionKey: parent,
      generation: 1,
    };
    const sibling = { ...createRun("sibling"), requesterSessionKey: parent };
    const latest = { ...old, runId: "latest", generation: 2 };
    const foreign = {
      ...old,
      runId: "foreign",
      childAgentId: "research",
      requesterSessionKey: "agent:main:other",
      generation: 3,
    };
    mocks.readCompactRuns.mockReturnValue(runMap(old, sibling, latest, foreign));
    await prepareSubagentSessionListReadCache();
    const read = () =>
      listControlledSubagentRunFacts(parent, "main", {}).map((entry) => entry.runId);
    expect(read()).toEqual([latest.runId, sibling.runId]);
    const moved = {
      ...latest,
      runId: "moved",
      requesterSessionKey: foreign.requesterSessionKey,
      generation: 4,
    };
    persistRegistryFixture(runMap(moved), [moved.runId]);
    expect(read()).toEqual([sibling.runId]);
  });

  it("scopes compact reads while preserving owner writes and live controller moves", async () => {
    const parent = "agent:main:parent";
    const selected = { ...createRun("selected"), controllerSessionKey: parent };
    const unrelated = createRun("unrelated");
    const runs = runMap(selected, unrelated);
    mocks.readCompactRuns.mockReturnValueOnce(new Map(runs));
    await prepareSubagentSessionListReadCache();
    readSnapshot(new Map());

    expect([...readSnapshot(new Map(), [parent]).keys()]).toEqual(["selected"]);
    expect(mocks.readCompactRuns).toHaveBeenCalledOnce();
    const moved = { ...selected, controllerSessionKey: "agent:main:other" };
    expect(readSnapshot(runMap(moved), [parent])).toEqual(new Map());

    vi.advanceTimersByTime(500);
    const refreshed = { ...selected, model: "updated-model" };
    runs.set(refreshed.runId, refreshed);
    persistRegistryFixture(runs, [refreshed.runId]);
    expect(readSnapshot(new Map(), [parent]).get("selected")?.model).toBe("updated-model");
    runs.set(refreshed.runId, { ...refreshed, controllerSessionKey: moved.controllerSessionKey });
    persistRegistryFixture(runs, [refreshed.runId]);
    expect(readSnapshot(new Map(), [parent])).toEqual(new Map());
    expect([...readSnapshot(new Map(), [moved.controllerSessionKey]).keys()]).toEqual([
      selected.runId,
    ]);
    expect(mocks.readCompactRuns).toHaveBeenCalledOnce();
    expect(readSnapshot(new Map(), [" "])).toEqual(new Map());
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
    persistRegistryFixture(runMap(grandchild));
    subagentRuns.set(child.runId, child);
    subagentRuns.set(unrelated.runId, unrelated);
    const read = () => [...readTree(subagentRuns, [root]).keys()];
    try {
      expect(read()).toEqual([grandchild.runId, child.runId]);
      const projection = readTree(subagentRuns, [root]).get(child.runId);
      expect(readSnapshot(subagentRuns).get(child.runId)).toBe(projection);
      const values = vi.spyOn(subagentRuns, "values");
      const entries = vi.spyOn(subagentRuns, Symbol.iterator);
      expect(read()).toEqual([grandchild.runId, child.runId]);
      subagentRuns.set(child.runId, { ...child, childSessionKey: "agent:main:moved" });
      expect(read()).toEqual([child.runId]);
      expect(readTree(subagentRuns, [root]).get(child.runId)).not.toBe(projection);
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
      persistRegistryFixture(runMap(older, descendant, newer));

      const selected = readTree(new Map(), [root]);
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
    mocks.readCompactRuns.mockReturnValue(runMap(old, successor, unrelated));
    await prepareSubagentSessionListReadCache();
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
      persistRegistryFixture(runMap(moved), [moved.runId]);
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
      persistRegistryFixture(runMap(old));
      expect(read()).toEqual(["old"]);
      expect(listener).toHaveBeenLastCalledWith(undefined);
    } finally {
      stop();
      subagentRuns.delete(old.runId);
    }
  });

  it("requires prepared exact-child facts and keeps live moves authoritative", async () => {
    const persisted = createRun("cold-move");
    persistRegistryFixture(runMap(persisted), [persisted.runId]);
    mocks.readCompactRuns.mockReturnValue(runMap(persisted));
    subagentRuns.set(persisted.runId, { ...persisted, childSessionKey: "agent:main:moved" });
    try {
      expect(readChildren([" "])).toEqual(new Map());
      expect(() => readChildren([persisted.childSessionKey])).toThrow("must be prepared");
      await prepareSubagentSessionListReadCache();
      expect(readChildren([persisted.childSessionKey])).toEqual(new Map());
      expect([...readChildren(["agent:main:moved"]).keys()]).toEqual([persisted.runId]);
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
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(runMap(first, unrelated, second));
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
    persistRegistryFixture(runMap(moved), [moved.runId]);
    expect([...(await read(new Map(), key)).keys()]).toEqual([second.runId]);
    const live = runMap(first);
    expect([...(await read(live, key)).keys()]).toEqual([second.runId, first.runId]);
    expect((await read(live, key)).get(first.runId)).toBe(first);
    persistRegistryFixture(runMap(first), [first.runId]);
    expect([...(await read(new Map(), key)).keys()]).toEqual([first.runId, second.runId]);
    const movedLive = runMap({ ...first, childSessionKey: "agent:main:elsewhere" });
    expect([...(await read(movedLive, key)).keys()]).toEqual([second.runId]);
    persistRegistryFixture(new Map(), [first.runId]);
    persistRegistryFixture(runMap(first), [first.runId]);
    expect([...(await read(new Map(), key)).keys()]).toEqual([second.runId, first.runId]);
    expect(unrelatedReads).toBe(0);
    expect(mocks.loadSubagentRegistryFromSqlite).toHaveBeenCalledOnce();
    expect(mocks.loadSubagentRunsForChildSessionFromSqlite).not.toHaveBeenCalled();
  });

  registerSubagentCollectorPublicationCases({
    createRun,
    mockRestoredRows: (runs) => mocks.loadSubagentRegistryFromSqlite.mockReturnValue(runs),
  });
});

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as stateReads from "../../../state/openclaw-state-db-readonly.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
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
  getSubagentSessionListRunsSnapshotForRead as readCompact,
  getSubagentSessionListRunsSnapshotForSessions as readTree,
  getSubagentRunsSnapshotForChildSession as readChild,
  getSubagentSessionListRunsSnapshotForChildSessions as readCompactChildren,
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

function createRun(runId: string, overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return createSubagentRunRecord({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    task: `task ${runId}`,
    createdAt: 1,
    execution: { status: "running", startedAt: 1 },
    ...overrides,
  });
}

const runMap = (...runs: SubagentRunRecord[]) => new Map(runs.map((run) => [run.runId, run]));

async function prepareCompact(...runs: SubagentRunRecord[]) {
  mocks.readCompactRuns.mockReturnValue(runMap(...runs));
  await prepareSubagentSessionListReadCache();
}

function addLiveRuns(...runs: SubagentRunRecord[]) {
  for (const run of runs) {
    subagentRuns.set(run.runId, run);
  }
  onTestFinished(() => {
    for (const run of runs) {
      subagentRuns.delete(run.runId);
    }
  });
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
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.nativeCompactRead.mockImplementation(() => {
      throw new Error("Compact registry reads must use the read worker");
    });
    vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementation(
      async (_options, command, options) => {
        const reply = { ok: true, type: command.type, sourceAdmitted: true } as const;
        if (command.type === "subagents.sessionList") {
          return { ...reply, type: command.type, runs: mocks.readCompactRuns() };
        }
        if (command.type === "subagents.runs" && command.scope.kind === "ids") {
          return {
            ...reply,
            type: command.type,
            runs: runMap(...mocks.readRunsByIds(command.scope.runIds)),
          };
        }
        if (command.type === "subagents.restore") {
          const runs = mocks.loadSubagentRegistryFromSqlite();
          options?.onChunk?.(
            [...runs.values()].map((entry) => ({ entry, createdAt: entry.createdAt })),
          );
          return { ...reply, type: command.type, count: runs.size };
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
    const selected = createRun("selected", { requesterSessionKey: parent });
    const runs = runMap(...Array.from({ length: 5_000 }, (_, i) => createRun(`other-${i}`)));
    runs.set(selected.runId, selected);
    mocks.readCompactRuns.mockReturnValue(runs);
    await prepareSubagentSessionListReadCache();
    const read = (key = parent) => listControlledSubagentRunFacts(key, "main", {});
    const ids = (key = parent) => read(key).map((entry) => entry.runId);
    expect(ids()).toEqual([selected.runId]);
    const scan = vi.spyOn(runs, "values");
    const iterate = vi.spyOn(runs, Symbol.iterator);
    const moved = { ...selected, controllerSessionKey: "agent:main:controller" };
    persistRegistryFixture(runMap(moved), [moved.runId]);
    expect(ids()).toEqual([selected.runId]);
    expect(ids("agent:main:controller")).toEqual([selected.runId]);
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
  });

  it("scopes compact reads while preserving owner writes and live controller moves", async () => {
    const parent = "agent:main:parent";
    const selected = createRun("selected", { controllerSessionKey: parent });
    const unrelated = createRun("unrelated");
    const runs = runMap(selected, unrelated);
    mocks.readCompactRuns.mockReturnValueOnce(new Map(runs));
    await prepareSubagentSessionListReadCache();
    readCompact(new Map());

    expect([...readCompact(new Map(), [parent]).keys()]).toEqual(["selected"]);
    expect(mocks.readCompactRuns).toHaveBeenCalledOnce();
    const moved = { ...selected, controllerSessionKey: "agent:main:other" };
    expect(readCompact(runMap(moved), [parent])).toEqual(new Map());

    vi.advanceTimersByTime(500);
    const refreshed = { ...selected, model: "updated-model" };
    runs.set(refreshed.runId, refreshed);
    persistRegistryFixture(runs, [refreshed.runId]);
    expect(readCompact(new Map(), [parent]).get("selected")?.model).toBe("updated-model");
    runs.set(refreshed.runId, { ...refreshed, controllerSessionKey: moved.controllerSessionKey });
    persistRegistryFixture(runs, [refreshed.runId]);
    expect(readCompact(new Map(), [parent])).toEqual(new Map());
    expect([...readCompact(new Map(), [moved.controllerSessionKey]).keys()]).toEqual([
      selected.runId,
    ]);
    expect(mocks.readCompactRuns).toHaveBeenCalledOnce();
    expect(readCompact(new Map(), [" "])).toEqual(new Map());
  });

  it("reads a warm session tree without enumerating unrelated live runs", async () => {
    await prepareEmptyReadCaches();
    const root = "agent:main:indexed-tree";
    const child = createRun("indexed-child", { requesterSessionKey: root });
    const grandchild = createRun("indexed-grandchild", {
      requesterSessionKey: child.childSessionKey,
    });
    const unrelated = createRun("indexed-unrelated");
    persistRegistryFixture(runMap(grandchild));
    addLiveRuns(child, unrelated);
    const read = () => [...readTree(subagentRuns, [root]).keys()];
    expect(read()).toEqual([grandchild.runId, child.runId]);
    const projection = readTree(subagentRuns, [root]).get(child.runId);
    expect(readCompact(subagentRuns).get(child.runId)).toBe(projection);
    const values = vi.spyOn(subagentRuns, "values");
    const entries = vi.spyOn(subagentRuns, Symbol.iterator);
    expect(read()).toEqual([grandchild.runId, child.runId]);
    subagentRuns.set(child.runId, { ...child, childSessionKey: "agent:main:moved" });
    expect(read()).toEqual([child.runId]);
    expect(readTree(subagentRuns, [root]).get(child.runId)).not.toBe(projection);
    expect(values).not.toHaveBeenCalled();
    expect(entries).not.toHaveBeenCalled();
  });

  it("retains all child generations when a newer global requester vetoes old descendants", async () => {
    const requesterSessionKey = "global";
    await prepareEmptyReadCaches();
    const root = "agent:main:tree";
    const older = createRun("older", { requesterSessionKey: root });
    const descendant = createRun("descendant", { requesterSessionKey: older.childSessionKey });
    const newer = createRun("newer", {
      childSessionKey: older.childSessionKey,
      requesterSessionKey,
      createdAt: 2,
      execution: { status: "running", startedAt: 2 },
    });
    persistRegistryFixture(runMap(older, descendant, newer));

    const selected = readTree(new Map(), [root]);
    expect([...selected.keys()]).toEqual([older.runId, descendant.runId, newer.runId]);
    const index = buildSubagentRunReadIndexFromRuns({ runs: selected, now: Date.now() });
    expect(index.latestRunsByChildSessionKey.get(older.childSessionKey)?.runId).toBe(newer.runId);
    expect(index.listDescendantRunsForRequester(root)).toEqual([]);
    expect(
      index.listDescendantRunsForRequester(requesterSessionKey).map((run) => run.runId),
    ).toEqual([newer.runId, descendant.runId]);
  });

  it("keeps exact child generations current through named moves, deletion, and live overlays", async () => {
    const old = createRun("old");
    const successor = createRun("successor", {
      childSessionKey: old.childSessionKey,
      generation: 2,
      requesterSessionKey: "agent:main:other",
    });
    const unrelated = createRun("unrelated");
    await prepareCompact(old, successor, unrelated);
    const read = () => [
      ...readCompactChildren([`  ${old.childSessionKey}  `, old.childSessionKey, " "]).keys(),
    ];
    const listener = vi.fn();
    onTestFinished(
      subscribeSubagentRunChanges("persistence", ({ sessionKeys }) => listener(sessionKeys)),
    );
    expect(read()).toEqual(["old", "successor"]);
    expect(readCompactChildren([old.childSessionKey]).get("successor")?.generation).toBe(2);
    const moved = { ...successor, childSessionKey: "agent:main:moved" };
    persistRegistryFixture(runMap(moved), [moved.runId]);
    expect(read()).toEqual(["old"]);
    expect(listener).toHaveBeenLastCalledWith(
      expect.arrayContaining([old.childSessionKey, moved.childSessionKey]),
    );
    addLiveRuns({ ...old, childSessionKey: moved.childSessionKey });
    expect(read()).toEqual([]);
    subagentRuns.delete(old.runId);
    persistRegistryFixture(new Map(), [old.runId]);
    expect(read()).toEqual([]);
    expect(mocks.readCompactRuns).toHaveBeenCalledOnce();
    expect(mocks.loadSubagentRegistryFromSqlite).not.toHaveBeenCalled();
    persistRegistryFixture(runMap(old));
    expect(read()).toEqual(["old"]);
    expect(listener).toHaveBeenLastCalledWith(undefined);
  });

  it("requires prepared exact-child facts and keeps live moves authoritative", async () => {
    const persisted = createRun("cold-move");
    persistRegistryFixture(runMap(persisted), [persisted.runId]);
    mocks.readCompactRuns.mockReturnValue(runMap(persisted));
    addLiveRuns({ ...persisted, childSessionKey: "agent:main:moved" });
    expect(readCompactChildren([" "])).toEqual(new Map());
    expect(() => readCompactChildren([persisted.childSessionKey])).toThrow("must be prepared");
    await prepareSubagentSessionListReadCache();
    expect(readCompactChildren([persisted.childSessionKey])).toEqual(new Map());
    expect([...readCompactChildren(["agent:main:moved"]).keys()]).toEqual([persisted.runId]);
    expect(mocks.loadSubagentRegistryFromSqlite).not.toHaveBeenCalled();
  });

  it("keeps warm child lookups scoped through cache publications and live moves", async () => {
    const key = "agent:main:selected";
    const first = createRun("first", { childSessionKey: key });
    const second = createRun("second", { childSessionKey: key });
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
    const read = readChild;
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
    persistRegistryFixture(new Map(), [first.runId]);
    persistRegistryFixture(runMap(first), [first.runId]);
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
    mocks.readCompactRuns.mockReturnValue(runMap(persisted));
    mocks.readRunsByIds.mockImplementation(() => [structuredClone(persisted)]);
    const live = runMap(inMemory);

    expect(await readChild(live, "agent:main:subagent:old")).toEqual(new Map());
  });

  registerSubagentCollectorPublicationCases({
    createRun,
    mockRestoredRows: (runs) => mocks.loadSubagentRegistryFromSqlite.mockReturnValue(runs),
  });
});

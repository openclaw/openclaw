// Subagent registry state tests cover hot read caching over the persisted SQLite snapshot.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionChanges } from "../../../sessions/session-row-changes.js";
import * as stateReads from "../../../state/openclaw-state-db-readonly.js";
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
  getSubagentRunsSnapshotForRead,
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

vi.mock("./subagent-registry-state.fixture.test-support.js", () => ({
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
              version: "fixture-version",
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

  it("publishes old and new retained-run keys only after their owner accepts the write", async () => {
    const previous = {
      ...createRun("retained"),
      requesterSessionKey: "agent:main:old-parent",
    };
    mocks.readCompactRuns.mockReturnValue(new Map([[previous.runId, previous]]));
    await prepareSubagentSessionListReadCache();
    getSubagentSessionListRunsSnapshotForRead(new Map());
    const changed = vi.fn();
    const stop = sessionChanges.subscribe(changed);
    try {
      const current = {
        ...previous,
        childSessionKey: "agent:main:subagent:moved",
        requesterSessionKey: "agent:main:new-parent",
        controllerSessionKey: "agent:main:controller",
        swarmRequesterSessionKey: "agent:main:swarm",
        collect: true,
      };
      const currentRuns = new Map([[current.runId, current]]);
      persistRegistryFixture(currentRuns, [current.runId]);
      expect(changed.mock.calls.map(([event]) => event)).toEqual([
        { sessionKey: previous.childSessionKey, scope: "runtime" },
        { sessionKey: previous.requesterSessionKey, scope: "runtime" },
        { sessionKey: current.childSessionKey, scope: "runtime" },
        { sessionKey: current.requesterSessionKey, scope: "runtime" },
        { sessionKey: current.controllerSessionKey, scope: "runtime" },
        { sessionKey: current.swarmRequesterSessionKey, scope: "runtime" },
      ]);
      changed.mockClear();

      mocks.saveSubagentRegistryChangesToSqlite.mockImplementationOnce(() => {
        throw new Error("write rolled back");
      });
      expect(() => persistRegistryFixture(new Map(), [current.runId])).toThrow("write rolled back");
      expect(changed).not.toHaveBeenCalled();

      const publish = publishSubagentRunsAfterAtomicStore(new Map(), [current.runId]);
      expect(changed).not.toHaveBeenCalled();
      publish();
      expect(changed.mock.calls.map(([event]) => event)).toEqual([
        { sessionKey: current.childSessionKey, scope: "runtime" },
        { sessionKey: current.requesterSessionKey, scope: "runtime" },
        { sessionKey: current.controllerSessionKey, scope: "runtime" },
        { sessionKey: current.swarmRequesterSessionKey, scope: "runtime" },
      ]);
      changed.mockClear();
      persistRegistryFixture(new Map());
      expect(changed.mock.calls).toEqual([[{ all: true, scope: "subagent-runs" }]]);
    } finally {
      stop();
    }
  });

  it.each([
    ["full", getSubagentRunsSnapshotForRead, mocks.loadSubagentRegistryFromSqlite],
    ["session-list", getSubagentSessionListRunsSnapshotForRead, mocks.readCompactRuns],
  ] as const)("keeps the loaded %s snapshot until an owner mutation", async (kind, read, load) => {
    const firstRun = createRun("run-first");
    load.mockReturnValue(new Map([[firstRun.runId, firstRun]]));
    if (kind === "session-list") {
      await prepareSubagentSessionListReadCache();
    } else {
      await restoreSubagentRunsFromDisk({ runs: new Map() });
    }

    expect([...read(new Map()).keys()]).toEqual(["run-first"]);
    vi.advanceTimersByTime(60_000);
    expect([...read(new Map()).keys()]).toEqual(["run-first"]);
    expect(load).toHaveBeenCalledOnce();

    const changed = { ...firstRun, execution: { status: "terminal" as const, endedAt: 2 } };
    persistRegistryFixture(new Map([[changed.runId, changed]]), [changed.runId]);
    vi.advanceTimersByTime(60_000);
    expect(read(new Map()).get(firstRun.runId)?.execution.status).toBe("terminal");
    expect(load).toHaveBeenCalledOnce();

    const replacement = createRun("replacement");
    persistRegistryFixture(new Map([[replacement.runId, replacement]]));
    vi.advanceTimersByTime(60_000);
    expect([...read(new Map()).keys()]).toEqual(["replacement"]);
    expect(load).toHaveBeenCalledOnce();
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

  it("loads retained rows when an incremental write precedes the first read", async () => {
    const retained = createRun("retained");
    const active = createRun("active");
    mocks.readCompactRuns.mockReturnValue(
      new Map([
        [retained.runId, retained],
        [active.runId, active],
      ]),
    );
    persistRegistryFixture(new Map([[active.runId, active]]), [active.runId]);
    await prepareSubagentSessionListReadCache();
    expect([...getSubagentSessionListRunsSnapshotForRead(new Map()).keys()]).toEqual([
      "retained",
      "active",
    ]);
    expect(mocks.readCompactRuns).toHaveBeenCalledOnce();
  });

  it("refreshes immutable session-list projections from authoritative writes", async () => {
    await prepareEmptyReadCaches();
    const savedRun = createRun("run-saved");
    savedRun.model = "openai/gpt-5.6";
    savedRun.swarmRunId = "stable-collector";
    savedRun.execution.outcome = { status: "ok", error: "not projected" };
    savedRun.delivery = { status: "pending" };

    persistRegistryFixture(new Map([[savedRun.runId, savedRun]]));

    const projected = getSubagentSessionListRunsSnapshotForRead(new Map()).get(savedRun.runId);
    expect(projected).toMatchObject({
      runId: savedRun.runId,
      model: savedRun.model,
      swarmRunId: "stable-collector",
      execution: { outcome: { status: "ok" } },
    });
    expect(projected?.execution.outcome).not.toHaveProperty("error");
    expect(() => {
      projected!.execution.outcome!.status = "error";
    }).toThrow(TypeError);
    expect(() => {
      projected!.delivery!.status = "delivered";
    }).toThrow(TypeError);
    expect(getSubagentSessionListRunsSnapshotForRead(new Map()).get(savedRun.runId)).toMatchObject({
      execution: { outcome: { status: "ok" } },
      delivery: { status: "pending" },
    });
    savedRun.execution.outcome = { status: "error", error: "replacement result" };
    savedRun.delivery.status = "delivered";
    persistRegistryFixture(new Map([[savedRun.runId, savedRun]]), [savedRun.runId]);
    expect(getSubagentSessionListRunsSnapshotForRead(new Map()).get(savedRun.runId)).toMatchObject({
      execution: { outcome: { status: "error" } },
      delivery: { status: "delivered" },
    });
    expect(projected).toMatchObject({
      execution: { outcome: { status: "ok" } },
      delivery: { status: "pending" },
    });
    expect(mocks.readCompactRuns).not.toHaveBeenCalled();
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

  it("keeps session-list tree reads on the shared write-through cache", async () => {
    await prepareEmptyReadCaches();
    const read = getSubagentSessionListRunsSnapshotForSessions;
    const root = "agent:main:tree";
    const child = { ...createRun("child"), requesterSessionKey: root };
    const grandchild = { ...createRun("grandchild"), requesterSessionKey: child.childSessionKey };
    const cycle = {
      ...createRun("cycle"),
      childSessionKey: root,
      requesterSessionKey: grandchild.childSessionKey,
    };
    const unrelated = createRun("unrelated");
    const runs = new Map([child, grandchild, cycle, unrelated].map((run) => [run.runId, run]));
    persistRegistryFixture(runs);
    vi.setSystemTime(1_499);
    expect([...read(new Map(), [root]).keys()]).toEqual(["child", "grandchild", "cycle"]);
    const moved = { ...grandchild, requesterSessionKey: "agent:main:other" };
    expect(
      read(new Map([[moved.runId, moved]]), [root]).get(moved.runId)?.requesterSessionKey,
    ).toBe(moved.requesterSessionKey);
    const memory = new Map([[grandchild.runId, grandchild]]);
    expect(read(memory, [root]).has(grandchild.runId)).toBe(true);
    const movedOut = { ...moved, childSessionKey: "agent:main:subagent:moved-out" };
    memory.set(movedOut.runId, movedOut);
    expect(read(memory, [root]).has(grandchild.runId)).toBe(false);
    expect(read(memory, [movedOut.requesterSessionKey]).get(movedOut.runId)).toMatchObject({
      childSessionKey: movedOut.childSessionKey,
      requesterSessionKey: movedOut.requesterSessionKey,
    });

    vi.advanceTimersByTime(60_000);
    const updated = { ...child, model: "updated-model" };
    runs.set(updated.runId, updated);
    persistRegistryFixture(runs, [updated.runId]);
    expect(read(new Map(), [root]).get(child.runId)).toMatchObject({ model: "updated-model" });
    const renamed = { ...updated, childSessionKey: "agent:main:subagent:renamed-child" };
    runs.set(renamed.runId, renamed);
    persistRegistryFixture(runs, [renamed.runId]);
    expect([...read(new Map(), [root]).keys()]).toEqual([child.runId, cycle.runId]);
    expect(read(new Map(), [root]).get(child.runId)?.childSessionKey).toBe(renamed.childSessionKey);
    expect(mocks.readCompactRuns).not.toHaveBeenCalled();
  });

  it.each(["agent:main:unrelated-requester", "global"])(
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

  it("keeps a shared session-list requester edge until its last member moves", async () => {
    await prepareEmptyReadCaches();
    const read = getSubagentSessionListRunsSnapshotForSessions;
    const root = "agent:main:shared-edge";
    const first = { ...createRun("first"), requesterSessionKey: root };
    const second = {
      ...createRun("second"),
      childSessionKey: first.childSessionKey,
      requesterSessionKey: root,
    };
    const descendant = { ...createRun("descendant"), requesterSessionKey: first.childSessionKey };
    const runs = new Map([first, second, descendant].map((run) => [run.runId, run]));
    persistRegistryFixture(runs);
    expect([...read(new Map(), [root]).keys()]).toEqual([
      first.runId,
      second.runId,
      descendant.runId,
    ]);

    runs.delete(first.runId);
    persistRegistryFixture(runs, [first.runId]);
    expect([...read(new Map(), [root]).keys()]).toEqual([second.runId, descendant.runId]);

    runs.set(first.runId, first);
    persistRegistryFixture(runs, [first.runId]);
    runs.set(second.runId, { ...second, requesterSessionKey: "agent:main:other" });
    persistRegistryFixture(runs, [second.runId]);
    expect([...read(new Map(), [root]).keys()]).toEqual([
      second.runId,
      descendant.runId,
      first.runId,
    ]);

    runs.set(first.runId, { ...first, requesterSessionKey: "agent:main:other" });
    persistRegistryFixture(runs, [first.runId]);
    expect(read(new Map(), [root])).toEqual(new Map());
    expect([...read(new Map(), ["agent:main:other"]).keys()]).toEqual([
      second.runId,
      descendant.runId,
      first.runId,
    ]);
  });

  it("preserves session-list snapshot order through named updates and delete/reinsert", async () => {
    const read = getSubagentSessionListRunsSnapshotForSessions;
    const readAll = getSubagentSessionListRunsSnapshotForRead;
    const load = mocks.readCompactRuns;
    const root = "agent:main:first-parent";
    const other = "agent:main:second-parent";
    const first = { ...createRun("first"), requesterSessionKey: root };
    const middle = { ...createRun("middle"), requesterSessionKey: other };
    const last = { ...createRun("last"), requesterSessionKey: root };
    load.mockReturnValueOnce(
      new Map([
        ["cached-alias-for-first", first],
        [middle.runId, middle],
        [last.runId, last],
      ]),
    );
    await prepareSubagentSessionListReadCache();
    expect([...readAll(new Map()).keys()]).toEqual([first.runId, middle.runId, last.runId]);
    const keys = [other, root];
    expect([...read(new Map(), keys).keys()]).toEqual([first.runId, middle.runId, last.runId]);

    const changed = { ...middle, model: "updated-model" };
    const writes = new Map([[changed.runId, changed]]);
    persistRegistryFixture(writes, [changed.runId]);
    const updated = read(new Map(), keys);
    expect([...updated.keys()]).toEqual([first.runId, middle.runId, last.runId]);
    expect(updated.get(middle.runId)?.model).toBe("updated-model");

    writes.delete(middle.runId);
    persistRegistryFixture(writes, [middle.runId]);
    expect([...read(new Map(), keys).keys()]).toEqual([first.runId, last.runId]);
    writes.set(middle.runId, changed);
    persistRegistryFixture(writes, [middle.runId]);
    expect([...read(new Map(), keys).keys()]).toEqual([first.runId, last.runId, middle.runId]);
    expect(load).toHaveBeenCalledOnce();
  });

  it("keeps cold committed deletions when complete session-list facts become ready", async () => {
    const readTree = getSubagentSessionListRunsSnapshotForSessions;
    const readAll = getSubagentSessionListRunsSnapshotForRead;
    const removed = createRun("removed");
    const retained = createRun("retained");
    const nested = { ...createRun("nested"), requesterSessionKey: removed.childSessionKey };
    const stored = new Map([removed, retained, nested].map((run) => [run.runId, run]));
    mocks.readCompactRuns.mockReturnValue(stored);
    persistRegistryFixture(new Map(), [removed.runId]);
    await prepareSubagentSessionListReadCache();

    expect([...readTree(new Map(), [removed.requesterSessionKey]).keys()]).toEqual([
      retained.runId,
    ]);
    expect([...readAll(new Map()).keys()]).toEqual([retained.runId, nested.runId]);
    expect(mocks.readCompactRuns).toHaveBeenCalledOnce();
  });

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

  it("hydrates one child in the worker and freezes its snapshot", async () => {
    const childSessionKey = "agent:main:subagent:child";
    const persisted = createRun("child");
    persisted.childSessionKey = childSessionKey;
    persisted.task = "persisted";
    mocks.readCompactRuns.mockReturnValue(new Map([[persisted.runId, persisted]]));
    mocks.readRunsByIds.mockImplementation(() => [structuredClone(persisted)]);

    const first = await getSubagentRunsSnapshotForChildSession(new Map(), childSessionKey);
    expect(() => {
      first.get("child")!.task = "mutated";
    }).toThrow(TypeError);
    const second = await getSubagentRunsSnapshotForChildSession(new Map(), childSessionKey);

    expect(second.get("child")?.task).toBe("persisted");
    expect(mocks.readRunsByIds).toHaveBeenCalledTimes(2);
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

  it("shares one immutable row publication across 2,000 prepared reads", async () => {
    const original = createRun("retained");
    const rows = new Map([[original.runId, original]]);
    publishSubagentRunsAfterAtomicStore(rows, undefined);
    const prepared = await prepareSubagentRunsSnapshotForRunIds(new Map(), [original.runId]);
    const snapshots = new Set<SubagentRunRecord>();
    for (let i = 0; i < 2_000; i++) {
      expect(
        prepared.consume((runs) => {
          snapshots.add(runs.get(original.runId)!);
        }).ready,
      ).toBe(true);
    }
    expect(snapshots.size).toBe(1);
    expect([...snapshots][0]).toBe(original);
    expect(() => {
      original.execution.status = "terminal";
    }).toThrow(TypeError);

    const next = { ...original, execution: { status: "terminal" as const, endedAt: 2 } };
    rows.set(next.runId, next);
    publishSubagentRunsAfterAtomicStore(rows, [next.runId]);
    expect(prepared.consume((runs) => runs.get(next.runId))).toEqual({ ready: true, value: next });
    const latest = await prepareSubagentRunsSnapshotForRunIds(new Map(), [next.runId]);
    expect(latest.consume((runs) => runs.get(next.runId) === next)).toEqual({
      ready: true,
      value: true,
    });
    expect(original.execution.status).toBe("running");
    expect(next).not.toBe(original);
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

// Subagent registry state tests cover hot read caching over the persisted SQLite snapshot.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../../sessions/session-row-changes.js";
import * as stateReads from "../../../state/openclaw-state-db-readonly.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { buildSubagentRunReadIndexFromRuns } from "./subagent-registry-queries.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentMaintenanceRunsSnapshotForRead,
  getSubagentSessionListRunsSnapshotForRead,
  getSubagentSessionListRunsSnapshotForSessions,
  getSubagentRunsSnapshotForChildSession,
  getSubagentSessionListRunsSnapshotForChildSessions,
  getSubagentRunsSnapshotForController,
  getSubagentRunsSnapshotForRead,
  getSubagentRunsSnapshotForSessions,
  prepareSubagentRunsSnapshotForRunIds,
  onSubagentRegistryPersisted,
  persistSubagentRunsToDisk,
  persistSubagentRunsToDiskOrThrow,
  prepareSubagentSessionListReadCache,
  publishSubagentRunsAfterAtomicStore,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-state.js";
import type { SubagentRunMaintenanceRecord, SubagentRunRecord } from "./subagent-registry.types.js";

const mocks = vi.hoisted(() => ({
  loadSubagentRunsForChildSessionFromSqlite:
    vi.fn<(childSessionKey: string) => SubagentRunRecord[]>(),
  loadSubagentRunsForControllerFromSqlite:
    vi.fn<(controllerSessionKey: string) => SubagentRunRecord[]>(),
  readRunsByIds: vi.fn<(runIds: readonly string[]) => SubagentRunRecord[]>(),
  loadSubagentRegistryFromSqlite: vi.fn<() => Map<string, SubagentRunRecord>>(),
  loadSubagentMaintenanceRunsFromSqlite: vi.fn<() => Map<string, SubagentRunMaintenanceRecord>>(),
  readCompactRuns: vi.fn<() => Map<string, SubagentRunReadRecord>>(),
  nativeCompactRead: vi.fn<() => Map<string, SubagentRunReadRecord>>(),
  loadSubagentRunsForSessionsFromSqlite: vi.fn<
    () => {
      sessionKeys: Set<string>;
      runs: Map<string, SubagentRunReadRecord>;
      complete: boolean;
    }
  >(),
  saveSubagentRegistryChangesToSqlite:
    vi.fn<(runs: Map<string, SubagentRunRecord>, changedRunIds: readonly string[]) => void>(),
  saveSubagentRegistryToSqlite: vi.fn<(runs: Map<string, SubagentRunRecord>) => void>(),
}));

vi.mock("./subagent-registry.store.sqlite.js", () => ({
  loadSubagentRunsForChildSessionFromSqlite: mocks.loadSubagentRunsForChildSessionFromSqlite,
  loadSubagentRunsForControllerFromSqlite: mocks.loadSubagentRunsForControllerFromSqlite,
  loadSubagentRegistryFromSqlite: mocks.loadSubagentRegistryFromSqlite,
  loadSubagentMaintenanceRunsFromSqlite: mocks.loadSubagentMaintenanceRunsFromSqlite,
  loadSubagentSessionListRunsFromSqlite: mocks.nativeCompactRead,
  loadSubagentRunsForSessionsFromSqlite: mocks.loadSubagentRunsForSessionsFromSqlite,
  saveSubagentRegistryChangesToSqlite: mocks.saveSubagentRegistryChangesToSqlite,
  saveSubagentRegistryToSqlite: mocks.saveSubagentRegistryToSqlite,
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
  };
}

describe("subagent registry state read cache", () => {
  const previousReadSqliteFlag = process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE = "1";
    clearSubagentRunsReadCacheForTest();
    mocks.loadSubagentRunsForChildSessionFromSqlite.mockReset();
    mocks.loadSubagentRunsForControllerFromSqlite.mockReset();
    mocks.readRunsByIds.mockReset();
    mocks.loadSubagentRegistryFromSqlite.mockReset();
    mocks.loadSubagentMaintenanceRunsFromSqlite.mockReset();
    mocks.readCompactRuns.mockReset();
    mocks.nativeCompactRead.mockReset().mockImplementation(() => {
      throw new Error("Compact registry reads must use the read worker");
    });
    mocks.loadSubagentRunsForSessionsFromSqlite.mockReset();
    mocks.saveSubagentRegistryChangesToSqlite.mockReset();
    mocks.saveSubagentRegistryToSqlite.mockReset();
    vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementation(
      async (_options, command) => {
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
      persistSubagentRunsToDiskOrThrow(currentRuns, [current.runId]);
      expect(changed.mock.calls.map(([event]) => event)).toEqual([
        { sessionKey: previous.childSessionKey },
        { sessionKey: previous.requesterSessionKey },
        { sessionKey: current.childSessionKey },
        { sessionKey: current.requesterSessionKey },
        { sessionKey: current.controllerSessionKey },
        { sessionKey: current.swarmRequesterSessionKey },
      ]);
      changed.mockClear();

      mocks.saveSubagentRegistryChangesToSqlite.mockImplementationOnce(() => {
        throw new Error("write rolled back");
      });
      expect(() => persistSubagentRunsToDiskOrThrow(new Map(), [current.runId])).toThrow(
        "write rolled back",
      );
      expect(changed).not.toHaveBeenCalled();

      const deferred: Array<() => void> = [];
      publishSubagentRunsAfterAtomicStore(new Map(), [current.runId], deferred);
      expect(changed).not.toHaveBeenCalled();
      deferred.forEach((publish) => publish());
      expect(changed.mock.calls.map(([event]) => event)).toEqual([
        { sessionKey: current.childSessionKey },
        { sessionKey: current.requesterSessionKey },
        { sessionKey: current.controllerSessionKey },
        { sessionKey: current.swarmRequesterSessionKey },
      ]);
      changed.mockClear();
      persistSubagentRunsToDiskOrThrow(new Map());
      expect(changed.mock.calls).toEqual([[{ all: true, scope: "subagent-runs" }]]);
    } finally {
      stop();
    }
  });

  it.each([
    ["full", getSubagentRunsSnapshotForRead, mocks.loadSubagentRegistryFromSqlite],
    ["session-list", getSubagentSessionListRunsSnapshotForRead, mocks.readCompactRuns],
    [
      "maintenance",
      getSubagentMaintenanceRunsSnapshotForRead,
      mocks.loadSubagentMaintenanceRunsFromSqlite,
    ],
  ] as const)("keeps the loaded %s snapshot until an owner mutation", async (kind, read, load) => {
    const firstRun = createRun("run-first");
    load.mockReturnValue(new Map([[firstRun.runId, firstRun]]));
    if (kind === "session-list") {
      await prepareSubagentSessionListReadCache();
    }

    expect([...read(new Map()).keys()]).toEqual(["run-first"]);
    vi.advanceTimersByTime(60_000);
    expect([...read(new Map()).keys()]).toEqual(["run-first"]);
    expect(load).toHaveBeenCalledOnce();

    const changed = { ...firstRun, execution: { status: "terminal" as const, endedAt: 2 } };
    persistSubagentRunsToDisk(new Map([[changed.runId, changed]]), [changed.runId]);
    vi.advanceTimersByTime(60_000);
    expect(read(new Map()).get(firstRun.runId)?.execution.status).toBe("terminal");
    expect(load).toHaveBeenCalledOnce();

    const replacement = createRun("replacement");
    persistSubagentRunsToDisk(new Map([[replacement.runId, replacement]]));
    vi.advanceTimersByTime(60_000);
    expect([...read(new Map()).keys()]).toEqual(["replacement"]);
    expect(load).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "invalidates loaded snapshots on restore, including empty stores (%s)",
    (empty) => {
      const stale = createRun("stale");
      persistSubagentRunsToDisk(new Map([[stale.runId, stale]]));
      const restored = empty
        ? new Map<string, SubagentRunRecord>()
        : new Map([["restored", createRun("restored")]]);
      mocks.loadSubagentRegistryFromSqlite.mockReturnValue(restored);
      mocks.readCompactRuns.mockReturnValue(restored);
      mocks.loadSubagentMaintenanceRunsFromSqlite.mockReturnValue(restored);

      restoreSubagentRunsFromDisk({ runs: new Map() });

      for (const read of [
        getSubagentRunsSnapshotForRead,
        getSubagentSessionListRunsSnapshotForRead,
        getSubagentMaintenanceRunsSnapshotForRead,
      ]) {
        expect([...read(new Map()).keys()]).toEqual([...restored.keys()]);
      }
    },
  );

  it("loads retained rows when an incremental write precedes the first read", async () => {
    const retained = createRun("retained");
    const active = createRun("active");
    mocks.readCompactRuns.mockReturnValue(
      new Map([
        [retained.runId, retained],
        [active.runId, active],
      ]),
    );
    persistSubagentRunsToDisk(new Map([[active.runId, active]]), [active.runId]);
    await prepareSubagentSessionListReadCache();
    expect([...getSubagentSessionListRunsSnapshotForRead(new Map()).keys()]).toEqual([
      "retained",
      "active",
    ]);
    expect(mocks.readCompactRuns).toHaveBeenCalledOnce();
  });

  it("refreshes the local read cache after successful writes", () => {
    const firstRun = createRun("run-first");
    const savedRun = createRun("run-saved");
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(new Map([[firstRun.runId, firstRun]]));

    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["run-first"]);

    persistSubagentRunsToDisk(new Map([[savedRun.runId, savedRun]]));

    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["run-saved"]);
    expect(mocks.saveSubagentRegistryToSqlite).toHaveBeenCalledOnce();
    expect(mocks.loadSubagentRegistryFromSqlite).toHaveBeenCalledTimes(1);
  });

  it("refreshes session-list projections from authoritative writes", () => {
    const savedRun = createRun("run-saved");
    savedRun.model = "openai/gpt-5.6";
    savedRun.swarmRunId = "stable-collector";
    savedRun.execution.outcome = { status: "ok", error: "not projected" };
    mocks.saveSubagentRegistryToSqlite.mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });

    persistSubagentRunsToDisk(new Map([[savedRun.runId, savedRun]]));

    const projected = getSubagentSessionListRunsSnapshotForRead(new Map()).get(savedRun.runId);
    expect(projected).toMatchObject({
      runId: savedRun.runId,
      model: savedRun.model,
      swarmRunId: "stable-collector",
      execution: { outcome: { status: "ok" } },
    });
    expect(projected?.execution.outcome).not.toHaveProperty("error");
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
    persistSubagentRunsToDisk(runs, [refreshed.runId]);
    expect(
      getSubagentSessionListRunsSnapshotForRead(new Map(), [parent]).get("selected")?.model,
    ).toBe("updated-model");
    runs.set(refreshed.runId, { ...refreshed, controllerSessionKey: moved.controllerSessionKey });
    persistSubagentRunsToDisk(runs, [refreshed.runId]);
    expect(getSubagentSessionListRunsSnapshotForRead(new Map(), [parent])).toEqual(new Map());
    expect([
      ...getSubagentSessionListRunsSnapshotForRead(new Map(), [moved.controllerSessionKey]).keys(),
    ]).toEqual([selected.runId]);
    expect(mocks.readCompactRuns).toHaveBeenCalledOnce();
    expect(getSubagentSessionListRunsSnapshotForRead(new Map(), [" "])).toEqual(new Map());
  });

  it.each([
    ["session-list", getSubagentSessionListRunsSnapshotForSessions],
    ["full", getSubagentRunsSnapshotForSessions],
  ] as const)("keeps %s tree reads on the shared write-through cache", (_kind, read) => {
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
    mocks.saveSubagentRegistryToSqlite.mockImplementationOnce(() => {
      throw new Error("best-effort write failed");
    });
    persistSubagentRunsToDisk(runs);
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
    expect(mocks.loadSubagentRunsForSessionsFromSqlite).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    const updated = { ...child, model: "updated-model" };
    runs.set(updated.runId, updated);
    persistSubagentRunsToDisk(runs, [updated.runId]);
    expect(read(new Map(), [root]).get(child.runId)).toMatchObject({ model: "updated-model" });
    const renamed = { ...updated, childSessionKey: "agent:main:subagent:renamed-child" };
    runs.set(renamed.runId, renamed);
    persistSubagentRunsToDisk(runs, [renamed.runId]);
    expect([...read(new Map(), [root]).keys()]).toEqual([child.runId, cycle.runId]);
    expect(read(new Map(), [root]).get(child.runId)?.childSessionKey).toBe(renamed.childSessionKey);
    expect(mocks.loadSubagentRunsForSessionsFromSqlite).not.toHaveBeenCalled();
    expect(mocks.readCompactRuns).not.toHaveBeenCalled();
  });

  it.each(["agent:main:unrelated-requester", "global"])(
    "retains all child generations when a newer %s requester vetoes old descendants",
    (requesterSessionKey) => {
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
      persistSubagentRunsToDisk(new Map([older, descendant, newer].map((run) => [run.runId, run])));

      const selected = getSubagentSessionListRunsSnapshotForSessions(new Map(), [root]);
      expect([...selected.keys()]).toEqual([older.runId, descendant.runId, newer.runId]);
      const index = buildSubagentRunReadIndexFromRuns({ runs: selected, now: Date.now() });
      expect(index.latestRunsByChildSessionKey.get(older.childSessionKey)?.runId).toBe(newer.runId);
      expect(index.listDescendantRunsForRequester(root)).toEqual([]);
      expect(
        index.listDescendantRunsForRequester(requesterSessionKey).map((run) => run.runId),
      ).toEqual([newer.runId, descendant.runId]);
      expect(mocks.loadSubagentRunsForSessionsFromSqlite).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["session-list", getSubagentSessionListRunsSnapshotForSessions],
    ["full", getSubagentRunsSnapshotForSessions],
  ] as const)("keeps a shared %s requester edge until its last member moves", (_kind, read) => {
    const root = "agent:main:shared-edge";
    const first = { ...createRun("first"), requesterSessionKey: root };
    const second = {
      ...createRun("second"),
      childSessionKey: first.childSessionKey,
      requesterSessionKey: root,
    };
    const descendant = { ...createRun("descendant"), requesterSessionKey: first.childSessionKey };
    const runs = new Map([first, second, descendant].map((run) => [run.runId, run]));
    persistSubagentRunsToDisk(runs);
    expect([...read(new Map(), [root]).keys()]).toEqual([
      first.runId,
      second.runId,
      descendant.runId,
    ]);

    runs.delete(first.runId);
    persistSubagentRunsToDisk(runs, [first.runId]);
    expect([...read(new Map(), [root]).keys()]).toEqual([second.runId, descendant.runId]);

    runs.set(first.runId, first);
    persistSubagentRunsToDisk(runs, [first.runId]);
    runs.set(second.runId, { ...second, requesterSessionKey: "agent:main:other" });
    persistSubagentRunsToDisk(runs, [second.runId]);
    expect([...read(new Map(), [root]).keys()]).toEqual([
      second.runId,
      descendant.runId,
      first.runId,
    ]);

    runs.set(first.runId, { ...first, requesterSessionKey: "agent:main:other" });
    persistSubagentRunsToDisk(runs, [first.runId]);
    expect(read(new Map(), [root])).toEqual(new Map());
    expect([...read(new Map(), ["agent:main:other"]).keys()]).toEqual([
      second.runId,
      descendant.runId,
      first.runId,
    ]);
    expect(mocks.loadSubagentRunsForSessionsFromSqlite).not.toHaveBeenCalled();
  });

  it.each([
    [
      "session-list",
      getSubagentSessionListRunsSnapshotForSessions,
      getSubagentSessionListRunsSnapshotForRead,
      mocks.readCompactRuns,
    ],
    [
      "full",
      getSubagentRunsSnapshotForSessions,
      getSubagentRunsSnapshotForRead,
      mocks.loadSubagentRegistryFromSqlite,
    ],
  ] as const)(
    "preserves %s snapshot order through named updates and delete/reinsert",
    async (kind, read, readAll, load) => {
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
      if (kind === "session-list") {
        await prepareSubagentSessionListReadCache();
      }
      expect([...readAll(new Map()).keys()]).toEqual([first.runId, middle.runId, last.runId]);
      const keys = [other, root];
      expect([...read(new Map(), keys).keys()]).toEqual([first.runId, middle.runId, last.runId]);

      const changed = { ...middle, model: "updated-model" };
      const writes = new Map([[changed.runId, changed]]);
      persistSubagentRunsToDisk(writes, [changed.runId]);
      const updated = read(new Map(), keys);
      expect([...updated.keys()]).toEqual([first.runId, middle.runId, last.runId]);
      expect(updated.get(middle.runId)?.model).toBe("updated-model");

      writes.delete(middle.runId);
      persistSubagentRunsToDisk(writes, [middle.runId]);
      expect([...read(new Map(), keys).keys()]).toEqual([first.runId, last.runId]);
      writes.set(middle.runId, changed);
      persistSubagentRunsToDisk(writes, [middle.runId]);
      expect([...read(new Map(), keys).keys()]).toEqual([first.runId, last.runId, middle.runId]);
      expect(load).toHaveBeenCalledOnce();
      expect(mocks.loadSubagentRunsForSessionsFromSqlite).not.toHaveBeenCalled();
    },
  );

  it("reuses a complete tree snapshot without making a partial tree globally authoritative", () => {
    const root = "agent:main:tree";
    const child = { ...createRun("child"), requesterSessionKey: root };
    const unrelated = createRun("unrelated");
    mocks.loadSubagentRunsForSessionsFromSqlite.mockReturnValue({
      sessionKeys: new Set([root, child.childSessionKey]),
      runs: new Map([[child.runId, child]]),
      complete: false,
    });
    expect(getSubagentRunsSnapshotForSessions(new Map(), [root]).size).toBe(1);
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(new Map([[unrelated.runId, unrelated]]));
    expect(getSubagentRunsSnapshotForRead(new Map()).has(unrelated.runId)).toBe(true);

    clearSubagentRunsReadCacheForTest();
    mocks.loadSubagentRunsForSessionsFromSqlite.mockReturnValue({
      sessionKeys: new Set([root, child.childSessionKey]),
      runs: new Map([[child.runId, child]]),
      complete: true,
    });
    expect(getSubagentRunsSnapshotForSessions(new Map(), [root]).size).toBe(1);
    expect(getSubagentRunsSnapshotForRead(new Map()).has(child.runId)).toBe(true);
    expect(getSubagentRunsSnapshotForRead(new Map()).has(unrelated.runId)).toBe(false);
    expect(mocks.loadSubagentRegistryFromSqlite).toHaveBeenCalledOnce();
  });

  it.each([
    ["full", getSubagentRunsSnapshotForSessions, getSubagentRunsSnapshotForRead],
    [
      "session-list",
      getSubagentSessionListRunsSnapshotForSessions,
      getSubagentSessionListRunsSnapshotForRead,
    ],
  ] as const)(
    "keeps cold failed deletions when complete %s facts become ready",
    async (kind, readTree, readAll) => {
      const removed = createRun("removed");
      const retained = createRun("retained");
      const nested = { ...createRun("nested"), requesterSessionKey: removed.childSessionKey };
      const stored = new Map([removed, retained, nested].map((run) => [run.runId, run]));
      mocks.readCompactRuns.mockReturnValue(stored);
      mocks.loadSubagentRunsForSessionsFromSqlite.mockReturnValue({
        sessionKeys: new Set([
          removed.requesterSessionKey,
          removed.childSessionKey,
          retained.childSessionKey,
          nested.childSessionKey,
        ]),
        runs: stored,
        complete: true,
      });
      mocks.saveSubagentRegistryChangesToSqlite.mockImplementationOnce(() => {
        throw new Error("disk unavailable");
      });
      persistSubagentRunsToDisk(new Map(), [removed.runId]);
      if (kind === "session-list") {
        await prepareSubagentSessionListReadCache();
      }

      expect([...readTree(new Map(), [removed.requesterSessionKey]).keys()]).toEqual([
        retained.runId,
      ]);
      expect([...readAll(new Map()).keys()]).toEqual([retained.runId, nested.runId]);
      expect(mocks.loadSubagentRunsForSessionsFromSqlite).toHaveBeenCalledTimes(
        kind === "full" ? 1 : 0,
      );
      expect(mocks.readCompactRuns).toHaveBeenCalledTimes(kind === "session-list" ? 1 : 0);
    },
  );

  it("preserves unrelated projected rows across incremental writes", async () => {
    const retained = createRun("retained");
    const changed = createRun("changed");
    mocks.readCompactRuns.mockReturnValue(
      new Map([
        [retained.runId, retained],
        [changed.runId, changed],
      ]),
    );
    await prepareSubagentSessionListReadCache();
    expect([...getSubagentSessionListRunsSnapshotForRead(new Map()).keys()]).toEqual([
      "retained",
      "changed",
    ]);

    changed.model = "openai/gpt-5.6";
    persistSubagentRunsToDisk(new Map([[changed.runId, changed]]), [changed.runId]);

    const projected = getSubagentSessionListRunsSnapshotForRead(new Map());
    expect([...projected.keys()]).toEqual(["retained", "changed"]);
    expect(projected.get(changed.runId)?.model).toBe("openai/gpt-5.6");
    expect(mocks.readCompactRuns).toHaveBeenCalledOnce();
  });

  it("updates only named runs in the local read cache", () => {
    const changed = createRun("changed");
    const untouched = createRun("untouched");
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(
      new Map([
        [changed.runId, changed],
        [untouched.runId, untouched],
      ]),
    );
    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["changed", "untouched"]);

    changed.task = "updated";
    const runs = new Map([
      [changed.runId, changed],
      [untouched.runId, untouched],
    ]);
    persistSubagentRunsToDisk(runs, [changed.runId]);

    expect(mocks.saveSubagentRegistryChangesToSqlite).toHaveBeenCalledWith(runs, [changed.runId]);
    expect(mocks.saveSubagentRegistryToSqlite).not.toHaveBeenCalled();
    expect(getSubagentRunsSnapshotForRead(new Map()).get(changed.runId)?.task).toBe("updated");
    expect(getSubagentRunsSnapshotForRead(new Map()).get(untouched.runId)?.task).toBe(
      untouched.task,
    );
  });

  it("keeps an exact deletion authoritative after a best-effort write failure", () => {
    const retained = createRun("retained");
    const removed = createRun("removed");
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(
      new Map([
        [retained.runId, retained],
        [removed.runId, removed],
      ]),
    );
    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["retained", "removed"]);
    mocks.saveSubagentRegistryChangesToSqlite.mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });

    persistSubagentRunsToDisk(new Map([[retained.runId, retained]]), [removed.runId]);

    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["retained"]);
  });

  it("wakes local readers when a best-effort write fails", () => {
    const staleRun = createRun("stale");
    const updatedRun = createRun("updated");
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(new Map([[staleRun.runId, staleRun]]));
    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["stale"]);
    const listener = vi.fn();
    const unsubscribe = onSubagentRegistryPersisted(listener);
    mocks.saveSubagentRegistryToSqlite.mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });

    persistSubagentRunsToDisk(new Map([[updatedRun.runId, updatedRun]]));

    expect(listener).toHaveBeenCalledOnce();
    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["updated"]);
    unsubscribe();
  });

  it("queries controller rows directly and overlays matching in-memory state", () => {
    const persisted = createRun("shared");
    persisted.controllerSessionKey = "agent:main:controller";
    persisted.task = "persisted";
    const inMemory = { ...persisted, task: "in-memory" };
    mocks.loadSubagentRunsForControllerFromSqlite.mockReturnValue([persisted]);

    const result = getSubagentRunsSnapshotForController(
      new Map([[inMemory.runId, inMemory]]),
      "agent:main:controller",
    );

    expect(result.get("shared")?.task).toBe("in-memory");
    expect(mocks.loadSubagentRunsForControllerFromSqlite).toHaveBeenCalledOnce();
    expect(getSubagentRunsSnapshotForController(new Map(), "   ")).toEqual(new Map());
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
    const stop = onSubagentRegistryPersisted(listener);
    try {
      expect(read()).toEqual(["old", "successor"]);
      expect(
        getSubagentSessionListRunsSnapshotForChildSessions([old.childSessionKey]).get("successor")
          ?.generation,
      ).toBe(2);
      const moved = { ...successor, childSessionKey: "agent:main:moved" };
      persistSubagentRunsToDisk(new Map([[moved.runId, moved]]), [moved.runId]);
      expect(read()).toEqual(["old"]);
      expect(listener).toHaveBeenLastCalledWith(
        expect.arrayContaining([old.childSessionKey, moved.childSessionKey]),
      );
      subagentRuns.set(old.runId, { ...old, childSessionKey: moved.childSessionKey });
      expect(read()).toEqual([]);
      subagentRuns.delete(old.runId);
      persistSubagentRunsToDisk(new Map(), [old.runId]);
      expect(read()).toEqual([]);
      expect(mocks.readCompactRuns).toHaveBeenCalledOnce();
      expect(mocks.loadSubagentRegistryFromSqlite).not.toHaveBeenCalled();
      persistSubagentRunsToDisk(new Map([[old.runId, old]]));
      expect(read()).toEqual(["old"]);
      expect(listener).toHaveBeenLastCalledWith(undefined);
    } finally {
      stop();
      subagentRuns.delete(old.runId);
    }
  });

  it("requires prepared exact-child facts and keeps live moves authoritative", async () => {
    const persisted = createRun("cold-move");
    persistSubagentRunsToDisk(new Map([[persisted.runId, persisted]]), [persisted.runId]);
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

  it("queries one child directly and returns isolated snapshots", () => {
    const childSessionKey = "agent:main:subagent:child";
    const persisted = createRun("child");
    persisted.childSessionKey = childSessionKey;
    persisted.task = "persisted";
    mocks.loadSubagentRunsForChildSessionFromSqlite.mockReturnValue([persisted]);

    const first = getSubagentRunsSnapshotForChildSession(new Map(), childSessionKey);
    first.get("child")!.task = "mutated";
    const second = getSubagentRunsSnapshotForChildSession(new Map(), childSessionKey);

    expect(second.get("child")?.task).toBe("persisted");
    expect(mocks.loadSubagentRunsForChildSessionFromSqlite).toHaveBeenCalledTimes(2);
  });

  it.each(["child", "controller"] as const)(
    "keeps warm %s lookups scoped through cache publications and live moves",
    (kind) => {
      const key = "agent:main:selected";
      const first = {
        ...createRun("first"),
        ...(kind === "child" ? { childSessionKey: key } : { requesterSessionKey: key }),
      };
      const second = {
        ...createRun("second"),
        ...(kind === "child" ? { childSessionKey: key } : { controllerSessionKey: key }),
      };
      const unrelated = createRun("unrelated");
      mocks.loadSubagentRegistryFromSqlite.mockReturnValue(
        new Map([first, unrelated, second].map((run) => [run.runId, run])),
      );
      const retained = getSubagentRunsSnapshotForRead(new Map());
      const read =
        kind === "child"
          ? getSubagentRunsSnapshotForChildSession
          : getSubagentRunsSnapshotForController;
      expect([...read(new Map(), key).keys()]).toEqual([first.runId, second.runId]);

      const field = kind === "child" ? "childSessionKey" : "controllerSessionKey";
      const original = unrelated[field];
      let unrelatedReads = 0;
      Object.defineProperty(retained.get(unrelated.runId)!, field, {
        enumerable: true,
        configurable: true,
        get() {
          unrelatedReads++;
          return original;
        },
      });
      const copied = read(new Map(), key);
      copied.get(first.runId)!.task = "caller-local change";
      expect(read(new Map(), key).get(first.runId)?.task).toBe(first.task);

      const moved = { ...first, [field]: "agent:main:elsewhere" };
      persistSubagentRunsToDisk(new Map([[moved.runId, moved]]), [moved.runId]);
      expect([...read(new Map(), key).keys()]).toEqual([second.runId]);
      const live = new Map([[first.runId, first]]);
      expect([...read(live, key).keys()]).toEqual([second.runId, first.runId]);
      expect(read(live, key).get(first.runId)).toBe(first);

      persistSubagentRunsToDisk(new Map([[first.runId, first]]), [first.runId]);
      expect([...read(new Map(), key).keys()]).toEqual([first.runId, second.runId]);
      persistSubagentRunsToDisk(new Map(), [first.runId]);
      persistSubagentRunsToDisk(new Map([[first.runId, first]]), [first.runId]);
      expect([...read(new Map(), key).keys()]).toEqual([second.runId, first.runId]);
      expect(unrelatedReads).toBe(0);
      expect(mocks.loadSubagentRegistryFromSqlite).toHaveBeenCalledOnce();
      expect(mocks.loadSubagentRunsForChildSessionFromSqlite).not.toHaveBeenCalled();
      expect(mocks.loadSubagentRunsForControllerFromSqlite).not.toHaveBeenCalled();
    },
  );

  it("masks persisted scope membership when the live run moved", () => {
    const persisted = createRun("moved");
    persisted.controllerSessionKey = "agent:main:controller:old";
    persisted.childSessionKey = "agent:main:subagent:old";
    const inMemory = {
      ...persisted,
      controllerSessionKey: "agent:main:controller:new",
      childSessionKey: "agent:main:subagent:new",
    };
    mocks.loadSubagentRunsForControllerFromSqlite.mockReturnValue([persisted]);
    mocks.loadSubagentRunsForChildSessionFromSqlite.mockReturnValue([persisted]);
    const live = new Map([[inMemory.runId, inMemory]]);

    expect(getSubagentRunsSnapshotForController(live, "agent:main:controller:old")).toEqual(
      new Map(),
    );
    expect(getSubagentRunsSnapshotForChildSession(live, "agent:main:subagent:old")).toEqual(
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
    mocks.readRunsByIds.mockReturnValue([selected]);
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

  it("preserves authoritative writes in scoped reads across idle time", () => {
    const controllerSessionKey = "agent:main:controller";
    const saved = createRun("saved");
    saved.controllerSessionKey = controllerSessionKey;
    mocks.saveSubagentRegistryToSqlite.mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });
    mocks.loadSubagentRunsForControllerFromSqlite.mockReturnValue([]);

    persistSubagentRunsToDisk(new Map([[saved.runId, saved]]));

    expect([
      ...getSubagentRunsSnapshotForController(new Map(), controllerSessionKey).keys(),
    ]).toEqual(["saved"]);
    expect(mocks.loadSubagentRunsForControllerFromSqlite).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect([
      ...getSubagentRunsSnapshotForController(new Map(), controllerSessionKey).keys(),
    ]).toEqual(["saved"]);
    expect(mocks.loadSubagentRunsForControllerFromSqlite).not.toHaveBeenCalled();
  });

  it("invalidates the strict collector parent after each committed lifecycle transition", () => {
    const run: SubagentRunRecord = {
      ...createRun("cross-agent"),
      childSessionKey: "agent:research:subagent:child",
      collect: true,
      swarmRequesterSessionKey: "global",
      requesterAgentId: "ops",
      groupId: "opaque-group",
      execution: { status: "queued" as const },
    };
    const runs = new Map([[run.runId, run]]);
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(new Map());
    getSubagentRunsSnapshotForRead(new Map());
    const observed: Array<{ event: SessionLifecycleEvent; stored?: SubagentRunRecord }> = [];
    const unsubscribe = onSessionLifecycleEvent((event) => {
      observed.push({ event, stored: getSubagentRunsSnapshotForRead(new Map()).get(run.runId) });
    });
    try {
      persistSubagentRunsToDiskOrThrow(runs, [run.runId]);
      run.execution = { status: "running", startedAt: 2 };
      persistSubagentRunsToDiskOrThrow(runs, [run.runId]);
      run.execution = { status: "terminal", endedAt: 3, outcome: { status: "ok" } };
      run.collectorCompletion = { status: "done", structured: { private: "child result" } };
      persistSubagentRunsToDiskOrThrow(runs, [run.runId]);
      run.task = "unrelated bookkeeping";
      persistSubagentRunsToDiskOrThrow(runs, [run.runId]);
      runs.delete(run.runId);
      persistSubagentRunsToDiskOrThrow(runs, [run.runId]);
      expect(observed.map(({ event }) => event)).toEqual(
        Array.from({ length: 4 }, () => ({
          sessionKey: "global",
          agentId: "ops",
          reason: "swarm",
        })),
      );
      expect(
        observed.map(
          ({ stored }) => stored?.collectorCompletion?.status ?? stored?.execution.status,
        ),
      ).toEqual(["queued", "running", "done", undefined]);
    } finally {
      unsubscribe();
    }
  });

  it.each([false, true])(
    "does not advance collector notifications on failed writes (strict=%s)",
    (strict) => {
      const run: SubagentRunRecord = {
        ...createRun("retry"),
        collect: true,
        swarmRequesterSessionKey: "agent:ops:parent",
        requesterAgentId: "ops",
        groupId: "batch",
      };
      const runs = new Map([[run.runId, run]]);
      persistSubagentRunsToDiskOrThrow(runs, [run.runId]);
      const received = vi.fn();
      const unsubscribe = onSessionLifecycleEvent(received);
      try {
        run.collectorCompletion = { status: "failed" };
        mocks.saveSubagentRegistryChangesToSqlite.mockImplementationOnce(() => {
          throw new Error("disk unavailable");
        });
        if (strict) {
          expect(() => persistSubagentRunsToDiskOrThrow(runs, [run.runId])).toThrow(
            "disk unavailable",
          );
        } else {
          persistSubagentRunsToDisk(runs, [run.runId]);
        }
        expect(received).not.toHaveBeenCalled();
        persistSubagentRunsToDiskOrThrow(runs, [run.runId]);
        expect(received).toHaveBeenCalledExactlyOnceWith({
          sessionKey: "agent:ops:parent",
          agentId: "ops",
          reason: "swarm",
        });
      } finally {
        unsubscribe();
      }
    },
  );

  it("invalidates archived cold-restored groups once per exact parent", () => {
    const rows = ["a", "b"].map((runId) => {
      const run = createRun(runId);
      run.collect = true;
      run.swarmRequesterSessionKey = "global";
      run.requesterAgentId = "ops";
      run.groupId = "batch";
      run.collectorCompletion = { status: "done" };
      return run;
    });
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(
      new Map(rows.map((row) => [row.runId, row])),
    );
    const runs = new Map<string, SubagentRunRecord>();
    const received = vi.fn();
    const unsubscribe = onSessionLifecycleEvent(received);
    try {
      restoreSubagentRunsFromDisk({ runs });
      expect(received).not.toHaveBeenCalled();
      runs.clear();
      persistSubagentRunsToDiskOrThrow(
        runs,
        rows.map((row) => row.runId),
      );
      expect(received).toHaveBeenCalledExactlyOnceWith({
        sessionKey: "global",
        agentId: "ops",
        reason: "swarm",
      });
    } finally {
      unsubscribe();
    }
  });

  it("defers atomic collector notifications until all owner snapshots are published", () => {
    const run: SubagentRunRecord = {
      ...createRun("atomic"),
      collect: true,
      swarmRequesterSessionKey: "agent:ops:parent",
      requesterAgentId: "ops",
      groupId: "batch",
    };
    const received = vi.fn();
    const unsubscribe = onSessionLifecycleEvent(received);
    try {
      const deferred: Array<() => void> = [];
      mocks.loadSubagentRegistryFromSqlite.mockReturnValue(new Map());
      getSubagentRunsSnapshotForRead(new Map());
      publishSubagentRunsAfterAtomicStore(new Map([[run.runId, run]]), [run.runId], deferred);
      expect(received).not.toHaveBeenCalled();
      expect(getSubagentRunsSnapshotForRead(new Map()).get(run.runId)?.groupId).toBe("batch");
      for (const publish of deferred) {
        publish();
      }
      expect(received).toHaveBeenCalledExactlyOnceWith({
        sessionKey: "agent:ops:parent",
        agentId: "ops",
        reason: "swarm",
      });
    } finally {
      unsubscribe();
    }
  });

  it("does not infer collector parent ownership from requester or group strings", () => {
    const base = { ...createRun("missing"), collect: true, groupId: "swarm:agent:ops:parent:run" };
    const rows: SubagentRunRecord[] = [
      base,
      { ...base, runId: "no-agent", swarmRequesterSessionKey: "agent:ops:parent" },
      { ...base, runId: "no-key", requesterAgentId: "ops" },
      {
        ...base,
        runId: "ordinary",
        collect: false,
        swarmRequesterSessionKey: "agent:ops:parent",
        requesterAgentId: "ops",
      },
    ];
    const received = vi.fn();
    const unsubscribe = onSessionLifecycleEvent(received);
    try {
      persistSubagentRunsToDiskOrThrow(new Map(rows.map((row) => [row.runId, row])));
      expect(received).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});

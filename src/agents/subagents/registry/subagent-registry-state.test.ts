// Subagent registry state tests cover hot read caching over the persisted SQLite snapshot.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as stateReads from "../../../state/openclaw-state-db-readonly.js";
import * as stateDatabase from "../../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { listControlledSubagentRunFacts } from "./subagent-control-scope.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { restoreSubagentRunsFromDisk } from "./subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import { buildSubagentRunReadIndexFromRuns } from "./subagent-registry-queries.js";
import { registerSubagentCollectorPublicationCases } from "./subagent-registry-state.collector.test-support.js";
import {
  persistRegistryFixture,
  saveSubagentRegistryToSqlite as save,
} from "./subagent-registry-state.fixture.test-support.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentSessionListRunsSnapshotForRead as readSnapshot,
  getSubagentSessionListRunsSnapshotForSessions as readTree,
  getSubagentRunsSnapshotForChildSession,
  getSubagentSessionListRunsSnapshotForChildSessions as readChildren,
  prepareSubagentSessionListReadCache,
} from "./subagent-registry-state.js";
import { registerSubagentRestoreCacheCases } from "./subagent-registry-state.restore.test-support.js";
import * as store from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

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
  let state: OpenClawTestState;
  const readCount = (type: string) =>
    vi
      .mocked(stateReads.executeExistingOpenClawStateRead)
      .mock.calls.filter(([, command]) => command.type === type).length;
  async function prepareEmptyReadCaches() {
    save(new Map());
    await restoreSubagentRunsFromDisk({ runs: new Map() });
    vi.mocked(stateReads.executeExistingOpenClawStateRead).mockClear();
  }
  beforeEach(async () => {
    state = await createOpenClawTestState({ scenario: "minimal", applyEnv: true });
    stateDatabase.openOpenClawStateDatabase();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
    vi.stubEnv("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1");
    clearSubagentRunsReadCacheForTest();
    vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    vi.spyOn(store, "loadSubagentSessionListRunsFromSqlite");
  });
  afterEach(async () => {
    expect(store.loadSubagentSessionListRunsFromSqlite).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    clearSubagentRunsReadCacheForTest();
    vi.useRealTimers();
    await state.cleanup();
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
    save(runMap(old, sibling, latest, foreign));
    await prepareSubagentSessionListReadCache();
    const read = () =>
      listControlledSubagentRunFacts(parent, "main", {}).map((entry) => entry.runId);
    expect(read()).toEqual([latest.runId, sibling.runId]);
    const controlled = { ...latest, controllerSessionKey: "agent:main:controller" };
    persistRegistryFixture(runMap(controlled), [controlled.runId]);
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
    persistRegistryFixture(runMap(moved), [moved.runId]);
    expect(read()).toEqual([sibling.runId]);
  });

  it("scopes compact reads while preserving owner writes and live controller moves", async () => {
    const parent = "agent:main:parent";
    const selected = { ...createRun("selected"), controllerSessionKey: parent };
    const unrelated = createRun("unrelated");
    const runs = runMap(selected, unrelated);
    save(runs);
    await prepareSubagentSessionListReadCache();
    readSnapshot(new Map());

    expect([...readSnapshot(new Map(), [parent]).keys()]).toEqual(["selected"]);
    expect(readCount("subagents.sessionList")).toBe(1);
    const moved = { ...selected, controllerSessionKey: "agent:main:other" };
    expect(readSnapshot(runMap(moved), [parent])).toEqual(new Map());

    vi.setSystemTime(1_500);
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
    expect(readCount("subagents.sessionList")).toBe(1);
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
    save(runMap(old, successor, unrelated));
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
      expect(readCount("subagents.sessionList")).toBe(1);
      expect(readCount("subagents.restore")).toBe(0);
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
    save(runMap(persisted));
    subagentRuns.set(persisted.runId, { ...persisted, childSessionKey: "agent:main:moved" });
    try {
      expect(readChildren([" "])).toEqual(new Map());
      expect(() => readChildren([persisted.childSessionKey])).toThrow("must be prepared");
      await prepareSubagentSessionListReadCache();
      expect(readChildren([persisted.childSessionKey])).toEqual(new Map());
      expect([...readChildren(["agent:main:moved"]).keys()]).toEqual([persisted.runId]);
      expect(readCount("subagents.restore")).toBe(0);
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
    save(runMap(first, unrelated, second));
    await restoreSubagentRunsFromDisk({ runs: new Map() });
    const read = getSubagentRunsSnapshotForChildSession;
    expect([...(await read(new Map(), key)).keys()]).toEqual([first.runId, second.runId]);
    const retained = (await read(new Map(), key)).get(first.runId)!;
    expect(() => {
      retained.task = "caller-local change";
    }).toThrow(TypeError);
    expect((await read(new Map(), key)).get(first.runId)).toBe(retained);
    expect((await read(new Map(), key)).get(first.runId)?.task).toBe(first.task);

    const moved = { ...first, childSessionKey: "agent:main:elsewhere" };
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
    expect(readCount("subagents.restore")).toBe(1);
  });

  registerSubagentCollectorPublicationCases({
    createRun,
    mockRestoredRows: save,
  });
});

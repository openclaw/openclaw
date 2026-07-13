// Subagent registry state tests cover hot read caching over the persisted SQLite snapshot.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentRunsSnapshotForController,
  getSubagentRunsSnapshotForRead,
  persistSubagentRunsToDisk,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const mocks = vi.hoisted(() => ({
  loadSubagentRegistryFromSqlite: vi.fn<() => Map<string, SubagentRunRecord>>(),
  loadSubagentRunsForControllerFromSqlite: vi.fn<() => SubagentRunRecord[]>(),
  saveSubagentRegistryToSqlite: vi.fn<(runs: Map<string, SubagentRunRecord>) => void>(),
}));

vi.mock("./subagent-registry.store.sqlite.js", () => ({
  loadSubagentRegistryFromSqlite: mocks.loadSubagentRegistryFromSqlite,
  loadSubagentRunsForControllerFromSqlite: mocks.loadSubagentRunsForControllerFromSqlite,
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
    startedAt: 1,
  };
}

describe("subagent registry state read cache", () => {
  const previousReadDiskFlag = process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK = "1";
    clearSubagentRunsReadCacheForTest();
    mocks.loadSubagentRegistryFromSqlite.mockReset();
    mocks.saveSubagentRegistryToSqlite.mockReset();
  });

  afterEach(() => {
    clearSubagentRunsReadCacheForTest();
    if (previousReadDiskFlag === undefined) {
      delete process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK;
    } else {
      process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK = previousReadDiskFlag;
    }
    vi.useRealTimers();
  });

  it("reuses persisted snapshots for hot reads within the ttl", () => {
    const firstRun = createRun("run-first");
    const secondRun = createRun("run-second");
    mocks.loadSubagentRegistryFromSqlite
      .mockReturnValueOnce(new Map([[firstRun.runId, firstRun]]))
      .mockReturnValueOnce(new Map([[secondRun.runId, secondRun]]));

    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["run-first"]);
    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["run-first"]);
    expect(mocks.loadSubagentRegistryFromSqlite).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(500);

    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["run-second"]);
    expect(mocks.loadSubagentRegistryFromSqlite).toHaveBeenCalledTimes(2);
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
});

describe("controller scoped snapshot equivalence", () => {
  const previousReadDiskFlag = process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK;

  function resolveControllerKey(entry: SubagentRunRecord): string {
    return entry.controllerSessionKey?.trim() || entry.requesterSessionKey;
  }

  beforeEach(() => {
    process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK = "1";
    clearSubagentRunsReadCacheForTest();
    mocks.loadSubagentRegistryFromSqlite.mockReset();
    mocks.loadSubagentRunsForControllerFromSqlite.mockReset();
  });

  afterEach(() => {
    clearSubagentRunsReadCacheForTest();
    if (previousReadDiskFlag === undefined) {
      delete process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK;
    } else {
      process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK = previousReadDiskFlag;
    }
  });

  it("produces identical entries to filtering the full snapshot", () => {
    const ctrlA = createRun("ctrl-direct");
    ctrlA.controllerSessionKey = "agent:main:ctrl-a";
    ctrlA.requesterSessionKey = "agent:main:other";

    const ctrlB = createRun("ctrl-fallback");
    ctrlB.controllerSessionKey = undefined;
    ctrlB.requesterSessionKey = "agent:main:ctrl-a";

    const ctrlOther = createRun("ctrl-other");
    ctrlOther.controllerSessionKey = "agent:main:other-ctrl";
    ctrlOther.requesterSessionKey = "agent:main:other";

    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(
      new Map([
        [ctrlA.runId, ctrlA],
        [ctrlB.runId, ctrlB],
        [ctrlOther.runId, ctrlOther],
      ]),
    );

    // Simulate: scoped SQL returns only rows matching the controller key.
    mocks.loadSubagentRunsForControllerFromSqlite.mockReturnValue([ctrlA, ctrlB]);

    const inMemoryRun = createRun("in-memory-match");
    inMemoryRun.controllerSessionKey = "agent:main:ctrl-a";
    inMemoryRun.requesterSessionKey = "agent:main:other";
    const inMemoryMap = new Map<string, SubagentRunRecord>([["in-memory-match", inMemoryRun]]);

    const scoped = getSubagentRunsSnapshotForController(inMemoryMap, "agent:main:ctrl-a");

    // Verify scoped result contains persisted matches + in-memory overlay
    expect(scoped.has(ctrlA.runId)).toBe(true);
    expect(scoped.has(ctrlB.runId)).toBe(true);
    expect(scoped.has(inMemoryRun.runId)).toBe(true);
    expect(scoped.has(ctrlOther.runId)).toBe(false);

    // Verify equivalence: scoped snapshot === filtering the full snapshot
    const fullSnapshot = new Map<string, SubagentRunRecord>();
    for (const [rid, entry] of mocks.loadSubagentRegistryFromSqlite().entries()) {
      fullSnapshot.set(rid, entry);
    }
    for (const [rid, entry] of inMemoryMap.entries()) {
      fullSnapshot.set(rid, entry);
    }
    const expectedIds = [...fullSnapshot.values()]
      .filter((e) => resolveControllerKey(e) === "agent:main:ctrl-a")
      .map((e) => e.runId)
      .toSorted();

    const scopedIds = [...scoped.values()].map((e) => e.runId).toSorted();
    expect(scopedIds).toEqual(expectedIds);
  });

  it("returns empty map for blank controller key without querying disk", () => {
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(new Map());

    const result = getSubagentRunsSnapshotForController(new Map(), "");
    expect(result.size).toBe(0);
    expect(mocks.loadSubagentRunsForControllerFromSqlite).not.toHaveBeenCalled();
  });

  it("caches scoped SQL results and reuses them for repeated calls", () => {
    const ctrlRun = createRun("cached-ctrl");
    ctrlRun.controllerSessionKey = "agent:main:ctrl-cache";
    ctrlRun.requesterSessionKey = "agent:main:other";

    mocks.loadSubagentRunsForControllerFromSqlite.mockReturnValue([ctrlRun]);

    // First call — queries SQLite
    const first = getSubagentRunsSnapshotForController(new Map(), "agent:main:ctrl-cache");
    expect(first.has(ctrlRun.runId)).toBe(true);
    expect(mocks.loadSubagentRunsForControllerFromSqlite).toHaveBeenCalledTimes(1);

    // Second call — uses cache, no additional SQLite query
    mocks.loadSubagentRunsForControllerFromSqlite.mockReturnValue([]);
    const second = getSubagentRunsSnapshotForController(new Map(), "agent:main:ctrl-cache");
    expect(second.has(ctrlRun.runId)).toBe(true);
    // Still 1 — cache short-circuits the store call
    expect(mocks.loadSubagentRunsForControllerFromSqlite).toHaveBeenCalledTimes(1);
  });

  it("invalidates scoped controller cache on persist", () => {
    const ctrlRun = createRun("inval-ctrl");
    ctrlRun.controllerSessionKey = "agent:main:ctrl-inval";
    ctrlRun.requesterSessionKey = "agent:main:other";

    mocks.loadSubagentRunsForControllerFromSqlite.mockReturnValue([ctrlRun]);

    // Populate the scoped cache
    const first = getSubagentRunsSnapshotForController(new Map(), "agent:main:ctrl-inval");
    expect(first.has(ctrlRun.runId)).toBe(true);
    expect(mocks.loadSubagentRunsForControllerFromSqlite).toHaveBeenCalledTimes(1);

    // Persist should invalidate scoped caches
    persistSubagentRunsToDisk(new Map([["some-run", createRun("some-run")]]));

    // Next call should query SQLite again (cache was cleared)
    const updated = createRun("updated-ctrl");
    updated.controllerSessionKey = "agent:main:ctrl-inval";
    updated.requesterSessionKey = "agent:main:other";
    mocks.loadSubagentRunsForControllerFromSqlite.mockReturnValue([updated]);

    const second = getSubagentRunsSnapshotForController(new Map(), "agent:main:ctrl-inval");
    expect(second.has(updated.runId)).toBe(true);
    expect(mocks.loadSubagentRunsForControllerFromSqlite).toHaveBeenCalledTimes(2);
  });
});

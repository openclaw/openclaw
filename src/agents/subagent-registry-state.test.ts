/**
 * Tests for subagent-registry-state caching behavior.
 *
 * Verifies that getSubagentRunsSnapshotForRead caches disk reads and that
 * persistSubagentRunsToDisk invalidates the cache.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getSubagentRunsSnapshotForRead,
  invalidateSubagentRunsCache,
  persistSubagentRunsToDisk,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

// Mock the sqlite module
vi.mock("./subagent-registry.store.sqlite.js", () => ({
  loadSubagentRegistryFromSqlite: vi.fn(() => new Map()),
  saveSubagentRegistryToSqlite: vi.fn(),
}));

// Re-import to get the mocked version
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";

const mockLoad = vi.mocked(loadSubagentRegistryFromSqlite);
const mockSave = vi.mocked(saveSubagentRegistryToSqlite);

describe("getSubagentRunsSnapshotForRead", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invalidateSubagentRunsCache();
    mockLoad.mockClear();
    mockSave.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeRun(id: string): SubagentRunRecord {
    return {
      runId: id,
      agentId: "test-agent",
      sessionId: "test-session",
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as SubagentRunRecord;
  }

  it("returns only in-memory runs in test environment", () => {
    // In test env (VITEST set), shouldReadDisk is false
    const inMemory = new Map([["run-1", makeRun("run-1")]]);
    const result = getSubagentRunsSnapshotForRead(inMemory);
    expect(result.size).toBe(1);
    expect(result.has("run-1")).toBe(true);
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("reads from disk when OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK=1", () => {
    process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK = "1";
    try {
      const diskRun = makeRun("disk-run");
      mockLoad.mockReturnValue(new Map([["disk-run", diskRun]]));

      const inMemory = new Map<string, SubagentRunRecord>();
      const result = getSubagentRunsSnapshotForRead(inMemory);

      expect(mockLoad).toHaveBeenCalledTimes(1);
      expect(result.has("disk-run")).toBe(true);
    } finally {
      delete process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK;
    }
  });

  it("caches disk reads and does not re-read within TTL", () => {
    process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK = "1";
    try {
      const diskRun = makeRun("disk-run");
      mockLoad.mockReturnValue(new Map([["disk-run", diskRun]]));

      const inMemory = new Map<string, SubagentRunRecord>();

      // First call - should read disk
      getSubagentRunsSnapshotForRead(inMemory);
      expect(mockLoad).toHaveBeenCalledTimes(1);

      // Second call within TTL - should use cache
      getSubagentRunsSnapshotForRead(inMemory);
      expect(mockLoad).toHaveBeenCalledTimes(1); // still 1

      // Third call within TTL - should still use cache
      getSubagentRunsSnapshotForRead(inMemory);
      expect(mockLoad).toHaveBeenCalledTimes(1); // still 1
    } finally {
      delete process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK;
    }
  });

  it("re-reads from disk after TTL expires", () => {
    process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK = "1";
    try {
      const diskRun1 = makeRun("disk-run-1");
      const diskRun2 = makeRun("disk-run-2");
      let callCount = 0;
      mockLoad.mockImplementation(() => {
        callCount++;
        return new Map([
          [`disk-run-${callCount}`, callCount === 1 ? diskRun1 : diskRun2],
        ]);
      });

      const inMemory = new Map<string, SubagentRunRecord>();

      // First call - reads disk (callCount=1)
      const result1 = getSubagentRunsSnapshotForRead(inMemory);
      expect(mockLoad).toHaveBeenCalledTimes(1);
      expect(result1.has("disk-run-1")).toBe(true);

      // Advance time past TTL (1s)
      vi.advanceTimersByTime(1100);

      // Second call - should re-read (callCount=2)
      const result2 = getSubagentRunsSnapshotForRead(inMemory);
      expect(mockLoad).toHaveBeenCalledTimes(2);
      expect(result2.has("disk-run-2")).toBe(true);
    } finally {
      delete process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK;
    }
  });

  it("invalidates cache after persistSubagentRunsToDisk", () => {
    process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK = "1";
    try {
      mockLoad.mockReturnValue(new Map([["run-a", makeRun("run-a")]]));

      const inMemory = new Map<string, SubagentRunRecord>();

      // First call - reads disk
      getSubagentRunsSnapshotForRead(inMemory);
      expect(mockLoad).toHaveBeenCalledTimes(1);

      // Persist a write - should invalidate cache
      const runs = new Map([["run-b", makeRun("run-b")]]);
      persistSubagentRunsToDisk(runs);
      expect(mockSave).toHaveBeenCalledWith(runs);

      // Next call should re-read disk
      mockLoad.mockReturnValue(new Map([["run-b", makeRun("run-b")]]));
      getSubagentRunsSnapshotForRead(inMemory);
      expect(mockLoad).toHaveBeenCalledTimes(2);
    } finally {
      delete process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK;
    }
  });

  it("merges disk runs with in-memory runs (in-memory wins on conflicts)", () => {
    process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK = "1";
    try {
      const diskRun = makeRun("shared-run");
      diskRun.status = "completed";
      mockLoad.mockReturnValue(new Map([["shared-run", diskRun]]));

      const memRun = makeRun("shared-run");
      memRun.status = "running";
      const inMemory = new Map([["shared-run", memRun]]);

      const result = getSubagentRunsSnapshotForRead(inMemory);
      expect(result.size).toBe(1);
      // In-memory run should override disk run (set after disk)
      expect(result.get("shared-run")?.status).toBe("running");
    } finally {
      delete process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK;
    }
  });
});

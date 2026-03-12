import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const loadSubagentRegistryFromDiskMock = vi.hoisted(() => vi.fn(() => new Map()));
const saveSubagentRegistryToDiskMock = vi.hoisted(() => vi.fn());

vi.mock("../persistence/postgres-client.js", () => ({
  getRuntimePostgresPersistencePolicySync: () => ({
    enabled: false,
    exportCompatibility: false,
  }),
}));

vi.mock("../persistence/service.js", () => ({
  loadSubagentRunsFromPostgres: vi.fn(async () => new Map()),
  persistSubagentRegistryToPostgres: vi.fn(async () => undefined),
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: () => loadSubagentRegistryFromDiskMock(),
  saveSubagentRegistryToDisk: (runs: Map<string, SubagentRunRecord>) =>
    saveSubagentRegistryToDiskMock(runs),
}));

const { clearRuntimeSubagentRunsSnapshot, persistSubagentRunsToDisk, restoreSubagentRunsFromDisk } =
  await import("./subagent-registry-state.js");

function createRun(runId: string): SubagentRunRecord {
  return {
    runId,
    childSessionKey: `agent:main:${runId}`,
    requesterSessionKey: "agent:main:root",
    requesterDisplayKey: "main",
    task: `task-${runId}`,
    cleanup: "keep",
    createdAt: Date.now(),
  };
}

describe("subagent registry filesystem mode", () => {
  beforeEach(() => {
    clearRuntimeSubagentRunsSnapshot();
    loadSubagentRegistryFromDiskMock.mockReset();
    saveSubagentRegistryToDiskMock.mockReset();
  });

  afterEach(() => {
    clearRuntimeSubagentRunsSnapshot();
  });

  it("reloads disk state instead of preferring the in-memory runtime snapshot", async () => {
    const localRuns = new Map([["run-local", createRun("run-local")]]);
    const diskRuns = new Map([["run-disk", createRun("run-disk")]]);
    loadSubagentRegistryFromDiskMock.mockReturnValue(diskRuns);

    persistSubagentRunsToDisk(localRuns);

    const restored = new Map<string, SubagentRunRecord>();
    const added = await restoreSubagentRunsFromDisk({ runs: restored });

    expect(added).toBe(1);
    expect([...restored.keys()]).toEqual(["run-disk"]);
    expect(saveSubagentRegistryToDiskMock).toHaveBeenCalledWith(localRuns);
  });
});

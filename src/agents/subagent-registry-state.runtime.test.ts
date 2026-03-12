import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("../persistence/postgres-client.js", () => ({
  getRuntimePostgresPersistencePolicySync: () => ({
    enabled: true,
    exportCompatibility: false,
  }),
}));

vi.mock("../persistence/service.js", () => ({
  loadSubagentRunsFromPostgres: vi.fn(async () => new Map()),
  persistSubagentRegistryToPostgres: vi.fn(async () => undefined),
}));

import {
  clearRuntimeSubagentRunsSnapshot,
  getSubagentRunsSnapshotForRead,
  replaceRuntimeSubagentRunsSnapshot,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function createRun(runId: string, childSessionKey: string): SubagentRunRecord {
  return {
    runId,
    childSessionKey,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: `task-${runId}`,
    cleanup: "keep",
    createdAt: Date.now(),
  };
}

describe("subagent registry runtime snapshot", () => {
  afterEach(() => {
    clearRuntimeSubagentRunsSnapshot();
  });

  it("prefers the runtime snapshot for read queries and merges local in-memory runs", () => {
    replaceRuntimeSubagentRunsSnapshot(
      new Map([["run-postgres", createRun("run-postgres", "agent:main:subagent:postgres")]]),
    );

    const merged = getSubagentRunsSnapshotForRead(
      new Map([["run-local", createRun("run-local", "agent:main:subagent:local")]]),
    );

    expect([...merged.keys()].toSorted()).toEqual(["run-local", "run-postgres"]);
    expect(merged.get("run-postgres")?.childSessionKey).toBe("agent:main:subagent:postgres");
    expect(merged.get("run-local")?.childSessionKey).toBe("agent:main:subagent:local");
  });
});

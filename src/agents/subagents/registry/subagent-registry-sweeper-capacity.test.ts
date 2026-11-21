import { expect, it, vi } from "vitest";
import { createOwnedWorkerTaskPool } from "../../../infra/worker-task-pool.js";
import * as stateReads from "../../../state/openclaw-state-db-readonly.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { compactSubagentRunForMemory } from "./subagent-registry-memory.js";
import { saveSubagentRegistryToSqlite } from "./subagent-registry-state.fixture.test-support.js";
import {
  createArchivedSubagentSweeperRun,
  createSubagentSweeperHarness,
} from "./subagent-registry-sweeper.test-support.js";

vi.mock("../../../state/openclaw-state-read-pool.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../state/openclaw-state-read-pool.js")>();
  return {
    ...actual,
    createStateReadPool: (...args: Parameters<typeof actual.createStateReadPool>) =>
      createOwnedWorkerTaskPool(
        {
          workerUrl: args[0],
          maxWorkers: 1,
          workerOptions: { resourceLimits: { maxOldGenerationSizeMb: 64 } },
        },
        { retainedTransport: true, nativeSource: args[1], databaseAccess: "read-only" },
      ),
  };
});

it("archives consecutive groups of 108 large retained tasks without killing its reader", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const rows = new Map(
      Array.from({ length: 108 }, (_, index) => {
        const runId = `archive-${index}`;
        return [
          runId,
          createArchivedSubagentSweeperRun({
            runId,
            childSessionKey: `agent:main:subagent:${runId}`,
            task: "x".repeat(384 * 1024),
            cleanupCompletedAt: Date.now() - 600_000,
            completion: { required: false },
            delivery: { status: "delivered" },
            collect: true,
            groupId: "archive-group",
            collectorCompletion: { status: "done" },
          }),
        ] as const;
      }),
    );
    const runs = new Map([...rows].map(([id, row]) => [id, compactSubagentRunForMemory(row)]));
    const harness = createSubagentSweeperHarness(runs.get("archive-0")!, runs);
    vi.mocked(stateWorker.runOpenClawStateWorkerOperation).mockRestore();
    harness.callGateway.mockResolvedValue({});
    for (let pass = 0; pass < 2; pass++) {
      saveSubagentRegistryToSqlite(rows);
      for (const [id, row] of rows) {
        runs.set(id, compactSubagentRunForMemory(row));
      }
      await harness.sweeper.runTick();
      expect(harness.warn.mock.calls).toEqual([]);
      expect(runs.size).toBe(0);
      const durable = await stateReads.executeExistingOpenClawStateRead(
        { env: state.env },
        {
          type: "subagents.runs",
          scope: { kind: "ids", runIds: [...rows.keys()] },
        },
      );
      expect(durable && "runs" in durable && durable.runs.size).toBe(0);
      expect(harness.sweepPendingLifecycle).toHaveBeenCalledTimes(pass + 1);
    }
  });
});

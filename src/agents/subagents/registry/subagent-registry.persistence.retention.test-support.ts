import { expect, it } from "vitest";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { saveSubagentRegistryToSqlite } from "./subagent-registry-state.fixture.test-support.js";

export function registerSubagentDismissedRetentionCases({
  getRegistry,
  withRegistryState,
  announceSpy,
}: {
  getRegistry: () => typeof import("./subagent-registry.test-helpers.js");
  withRegistryState: (run: () => Promise<void>) => Promise<void>;
  announceSpy: unknown;
}) {
  it("keeps dismissed delivery dormant under session retention after restore", async () => {
    const mod = getRegistry();
    await withRegistryState(async () => {
      const now = Date.now();
      const run = createSubagentRunRecord({
        runId: "run-dismissed-delivery",
        childSessionKey: "agent:main:subagent:dismissed-delivery",
        task: "retain no delivery obligation",
        spawnMode: "session",
        createdAt: now - 10 * 60_000,
        endedReason: "subagent-complete",
        startedAt: now - 9 * 60_000,
        endedAt: now - 8 * 60_000,
        outcome: { status: "ok" },
        expectsCompletionMessage: true,
        completion: { required: true, resultText: "done", capturedAt: now - 8 * 60_000 },
        delivery: {
          status: "discarded",
          disposition: "intentional_non_delivery",
          dismissedAt: now - 6 * 60_000,
        },
        cleanupHandled: true,
        cleanupCompletedAt: now - 6 * 60_000,
      });
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));

      await mod.initSubagentRegistry();
      await mod.testing.sweepOnceForTests();

      expect(announceSpy).not.toHaveBeenCalled();
      expect(mod.getSubagentRunByRunId(run.runId)).toBeUndefined();
    });
  });
}

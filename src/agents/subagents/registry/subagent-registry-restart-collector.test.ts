import { expect, it } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../../../config/config.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { createSubagentRegistryRestorer } from "./subagent-registry-restore.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import {
  markSubagentRunTerminated,
  resetSubagentRegistryForTests,
  testing,
} from "./subagent-registry.test-helpers.js";

it.each(["crash", "shutdown"] as const)(
  "collects recorded child outcomes after %s",
  async (restart) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await resetSubagentRegistryForTests({ persist: false });
      await captureRuntimeConfigAsyncReader()();
      const startedAt = Math.floor(performance.timeOrigin) - 1000;
      const entries = ["captured", "interrupted-1", "interrupted-2"].map((runId) =>
        createSubagentRunRecord({
          runId,
          childAgentId: "main",
          childSessionKey: `agent:main:subagent:${runId}`,
          childSessionIdentity: { sessionId: runId, lifecycleRevision: runId },
          requesterSessionKey: "agent:main:main",
          requesterAgentId: "main",
          swarmRequesterSessionKey: "agent:main:main",
          collect: true,
          expectsCompletionMessage: false,
          createdAt: startedAt,
          execution:
            runId === "captured"
              ? { status: "terminal", startedAt, endedAt: startedAt + 1, outcome: { status: "ok" } }
              : { status: "running", startedAt },
          ...(runId === "captured"
            ? {
                completion: {
                  required: false,
                  resultText: "saved result",
                  capturedAt: startedAt + 1,
                },
                collectorCompletion: { status: "done" },
              }
            : {}),
        }),
      );
      entries[0]!.requiresCompletionAuthority = true;
      const restore = () =>
        createSubagentRegistryRestorer({
          runs: subagentRuns,
          ensureListener() {},
          warn() {},
        }).activate();
      try {
        saveSubagentRegistryToSqlite(new Map(entries.map((entry) => [entry.runId, entry])));
        await restore();
        if (restart === "shutdown") {
          for (const entry of entries.slice(1)) {
            await markSubagentRunTerminated({
              runId: entry.runId,
              reason: "Gateway stopped",
              suppressTaskDelivery: true,
              suppressSessionEffects: true,
            });
          }
          await resetSubagentRegistryForTests({ persist: false });
          await restore();
        }
        const tool = createAgentsWaitTool({
          agentSessionKey: "agent:main:main",
          agentId: "main",
          config: { tools: { swarm: true } },
        });
        const args = { ids: entries.map((entry) => entry.runId), awaitResults: true };
        const signal = AbortSignal.timeout(1500);
        const waiting = tool.execute("wait", args, signal);
        await testing.sweepOnceForTests();
        const expected = {
          completed: [
            { runId: "captured", status: "done", result: "saved result" },
            ...entries.slice(1).map((entry) => ({
              runId: entry.runId,
              status: restart === "shutdown" ? "killed" : "failed",
              error: expect.stringMatching(/restart|Gateway stopped/),
            })),
          ],
          pending: [],
        };
        expect((await waiting).details).toMatchObject(expected);
        const restoredParticipant = subagentRuns.get("captured")!;
        expect(restoredParticipant.requiresCompletionAuthority).toBe(true);
        const ownerEffect = () => {
          throw new Error("Owner fallback executed");
        };
        expect(() =>
          subagentRuns.runWithCompletionAuthority(restoredParticipant, ownerEffect),
        ).toThrow("Constrained completion requires");
        expect(() =>
          subagentRuns.runWithCompletionBatchAuthority([restoredParticipant], ownerEffect),
        ).toThrow("Constrained completion requires");
        // A late waiter must read the durable result without a new completion event.
        expect((await tool.execute("late-wait", args, signal)).details).toMatchObject(expected);
        for (const entry of entries) {
          expect(subagentRuns.isCompletionAuthorityRetired(subagentRuns.get(entry.runId)!)).toBe(
            true,
          );
        }
      } finally {
        await resetSubagentRegistryForTests({ persist: false });
      }
    });
  },
);

it("restores legacy shutdown outcomes without reviving explicit Stop or delivered work", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await resetSubagentRegistryForTests({ persist: false });
    await captureRuntimeConfigAsyncReader()();
    const endedAt = Math.floor(performance.timeOrigin) - 1000;
    const entries = ["interrupted", "explicit-stop", "delivered"].map((runId) =>
      createSubagentRunRecord({
        runId,
        childAgentId: "main",
        childSessionKey: `agent:main:subagent:${runId}`,
        childSessionIdentity: { sessionId: runId, lifecycleRevision: runId },
        requesterSessionKey: "agent:main:main",
        requesterAgentId: "main",
        spawnMode: "run",
        cleanup: "keep",
        expectsCompletionMessage: true,
        execution: {
          status: "terminal",
          startedAt: endedAt - 10_000_000,
          endedAt,
          outcome: { status: "error", error: "Gateway stopped" },
          suppressSessionEffects: true,
        },
        endedReason: "subagent-killed",
        completion: { required: true },
        delivery: { status: runId === "delivered" ? "delivered" : "pending" },
        cleanupHandled: true,
        cleanupCompletedAt: endedAt,
        suppressAnnounceReason: "killed",
        killReconciliation: {
          killedAt: endedAt,
          suppressTaskDelivery: true,
          taskCancellationAccepted: runId === "explicit-stop" ? true : undefined,
        },
      }),
    );
    try {
      saveSubagentRegistryToSqlite(new Map(entries.map((entry) => [entry.runId, entry])));
      await createSubagentRegistryRestorer({
        runs: subagentRuns,
        ensureListener() {},
        warn() {},
      }).activate();
      const stored = loadSubagentRegistryFromSqlite();
      expect(stored.get("interrupted")).toMatchObject({
        endedReason: "subagent-error",
        completion: { required: true, resultText: null, capturedAt: endedAt },
        delivery: { status: "pending" },
        cleanupHandled: false,
      });
      expect(stored.get("interrupted")?.killReconciliation).toBeUndefined();
      expect(stored.get("interrupted")?.cleanupCompletedAt).toBeUndefined();
      for (const runId of ["explicit-stop", "delivered"]) {
        expect(stored.get(runId)).toMatchObject({
          endedReason: "subagent-killed",
          cleanupCompletedAt: endedAt,
          killReconciliation: { killedAt: endedAt, suppressTaskDelivery: true },
        });
      }
      // Restoring metadata grants no authority to deliver historical work.
      for (const entry of subagentRuns.values()) {
        expect(subagentRuns.isCompletionAuthorityRetired(entry)).toBe(true);
      }
    } finally {
      await resetSubagentRegistryForTests({ persist: false });
    }
  });
});

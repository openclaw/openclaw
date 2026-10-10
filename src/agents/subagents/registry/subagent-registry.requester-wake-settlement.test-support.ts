import { expect, it, vi } from "vitest";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { createSubagentRunParams } from "../../subagent-test-fixtures.test-helpers.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import { mutateRequesterCompletionBatch } from "../completion/subagent-completion-admission.store.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { countActiveDescendantRunsFromRuns } from "./subagent-registry-queries.js";
import type { GatewayRequest } from "./subagent-registry.lifecycle-fixture.test-support.js";
import { createRequesterYieldTool } from "./subagent-registry.requester-wake-receipts.test-support.js";
import * as registry from "./subagent-registry.test-helpers.js";

export function registerRequesterWakeSettlementBoundaryTests({
  requesterSessionKey,
  spawnVisibleChild,
  emitCompleted,
  flushOwnedWork,
  waitForDeliveredCleanup,
  getRequesterWakeCalls,
  useGlobalSessionScope,
}: {
  requesterSessionKey: string;
  spawnVisibleChild: (params: {
    runId: string;
    childSessionKey: string;
    requesterTurnRunId: string;
  }) => Promise<void>;
  emitCompleted: (runId: string, childSessionKey: string, text: string) => void;
  flushOwnedWork: () => Promise<void>;
  waitForDeliveredCleanup: (runId: string) => Promise<void>;
  getRequesterWakeCalls: () => GatewayRequest[];
  useGlobalSessionScope: () => void;
}): void {
  it("delivers a yielded result despite an older failed grandchild awaiting cleanup", async () => {
    const oldTime = Date.now() - 5 * 24 * 60 * 60 * 1000;
    const oldParentKey = "agent:main:subagent:old-parent";
    await registry.addSubagentRunForTests({
      ...createSubagentRunParams({
        runId: "old-parent",
        childSessionKey: oldParentKey,
        requesterSessionKey,
        requesterAgentId: "main",
      }),
      createdAt: oldTime,
      execution: { status: "terminal", startedAt: oldTime, endedAt: oldTime + 100 },
      delivery: { status: "delivered", disposition: "delivered" },
      cleanupCompletedAt: oldTime + 100,
    });
    await registry.addSubagentRunForTests({
      ...createSubagentRunParams({
        runId: "old-grandchild",
        childSessionKey: "agent:main:subagent:old-grandchild",
        requesterSessionKey: oldParentKey,
        requesterAgentId: "main",
      }),
      createdAt: oldTime + 10,
      execution: {
        status: "terminal",
        startedAt: oldTime + 10,
        endedAt: oldTime + 50,
        outcome: { status: "error", error: "Gateway lifecycle dispatch unavailable" },
      },
      delivery: { status: "pending" },
      completion: { required: true, resultText: "unrelated old result" },
    });

    const requesterTurnRunId = "current-requester";
    const child = {
      runId: "current-child",
      childSessionKey: "agent:main:subagent:current-child",
      expectsCompletionMessage: true,
    };
    await spawnVisibleChild({ ...child, requesterTurnRunId });
    await createRequesterYieldTool(requesterSessionKey, requesterTurnRunId).execute(
      "yield-current-result",
      {},
    );
    const { withLocalSessionPlacementTurnSettlement } =
      await import("../../session-placement-admission.js");
    await withLocalSessionPlacementTurnSettlement(
      {
        sessionId: "sess-main",
        sessionKey: requesterSessionKey,
        agentId: "main",
        runId: requesterTurnRunId,
      },
      async () => ({
        acceptedSessionSpawns: [child],
        meta: {
          durationMs: 1,
          yielded: true,
          executionTrace: { runner: "cli", attempts: [], fallbackUsed: false },
        },
      }),
    );
    emitCompleted(child.runId, child.childSessionKey, "current counting result");
    await flushOwnedWork();
    await waitForDeliveredCleanup(child.runId);

    expect(getRequesterWakeCalls()).toHaveLength(1);
    const wakeMessage = getRequesterWakeCalls()[0]?.params?.message;
    expect(wakeMessage).toContain("current counting result");
    expect(wakeMessage).not.toContain("unrelated old result");
    expect(registry.getSubagentRunByRunId("old-grandchild")).toMatchObject({
      delivery: { status: "pending" },
    });
    expect(registry.getSubagentRunByRunId("old-grandchild")?.cleanupCompletedAt).toBeUndefined();
  });

  it("delivers a stale requester batch despite foreign active work in a global session", async () => {
    vi.setSystemTime(100_000);
    useGlobalSessionScope();
    await registry.addSubagentRunForTests({
      runId: "run-main-batch",
      childSessionKey: "agent:main:subagent:batch",
      requesterSessionKey,
      requesterDisplayKey: "main",
      requesterAgentId: "main",
      task: "main completed batch",
      cleanup: "keep",
      createdAt: 1_000,
      execution: {
        status: "terminal",
        startedAt: 1_100,
        endedAt: 1_200,
        outcome: { status: "ok" },
      },
      expectsCompletionMessage: true,
      delivery: { status: "pending" },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        batchRunIds: ["run-main-batch"],
        requesterYieldBatch: true,
        rearmGeneration: 1,
        deferralCount: 8,
      },
    });
    await registry.addSubagentRunForTests({
      runId: "run-main-stale",
      childSessionKey: "agent:main:subagent:stale",
      requesterSessionKey: "agent:main:subagent:batch",
      requesterDisplayKey: "main",
      requesterAgentId: "main",
      task: "main stale settle blocker",
      cleanup: "keep",
      createdAt: 2_000,
      execution: {
        status: "terminal",
        startedAt: 2_100,
        endedAt: 2_200,
        outcome: { status: "ok" },
      },
      expectsCompletionMessage: true,
      delivery: { status: "pending" },
    });
    await registry.addSubagentRunForTests({
      runId: "run-research-active",
      childSessionKey: "agent:research:subagent:active",
      requesterSessionKey,
      requesterDisplayKey: "main",
      requesterAgentId: "research",
      task: "unrelated research work",
      cleanup: "keep",
      createdAt: 3_000,
      execution: { status: "running", startedAt: 3_100 },
    });

    const transitions: Array<{ deferralCount?: number; nextAttemptAt?: number }> = [];
    const completions: Array<{ delivered: boolean; error?: string }> = [];
    const runWake = () => {
      const batch = registry.getSubagentRunByRunId("run-main-batch");
      if (!batch) {
        throw new Error("expected main requester batch");
      }
      return maybeWakeRequesterAfterAllChildrenSettled({
        isSourceCurrent: () => true,
        requesterSessionKey,
        settledEntry: batch,
        transitionBatch: async (entries, state, onPublished) => {
          const publication = await mutateRequesterCompletionBatch({
            entries,
            operation: { kind: "transition", state },
            context: captureOpenClawStateWorkerContext(),
            assertCurrent: () => {},
            onCommitted: () => {},
            onPublished: () =>
              onPublished(entries.map((entry) => registry.getSubagentRunByRunId(entry.runId)!)),
          });
          expect(publication).toEqual({ applied: true, publication: "published" });
          transitions.push({
            deferralCount: state.deferralCount,
            nextAttemptAt: state.nextAttemptAt,
          });
        },
        completeBatch: async (entries, _rearmGeneration, outcome) => {
          if (!outcome) {
            throw new Error("Expected a requester delivery outcome");
          }
          const publication = await mutateRequesterCompletionBatch({
            entries,
            operation: { kind: "settle", outcome },
            assertCurrent: () => {},
          });
          expect(publication).toEqual({ applied: true, publication: "published" });
          completions.push({ delivered: outcome.delivered, error: outcome.error });
        },
      });
    };

    await expect(runWake()).resolves.toBe(false);
    expect(transitions).toEqual([{ deferralCount: 9, nextAttemptAt: 130_000 }]);
    expect(completions).toEqual([]);

    await expect(runWake()).resolves.toBe(false);
    expect(transitions).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30_000);
    // The spent stale-blocker wait delivers the completed batch instead of
    // terminalizing it as undelivered.
    await expect(runWake()).resolves.toBe(true);
    expect(getRequesterWakeCalls()).toHaveLength(1);
    expect(getRequesterWakeCalls()[0]?.params?.message).toContain(
      "a descendant result below it was still undelivered",
    );
    expect(completions).toEqual([{ delivered: true, error: undefined }]);
    expect(registry.getSubagentRunByRunId("run-main-batch")?.requesterSettleWake).toBeUndefined();
    expect(countActiveDescendantRunsFromRuns(subagentRuns, requesterSessionKey)).toBe(1);
    expect(countActiveDescendantRunsFromRuns(subagentRuns, requesterSessionKey, "main")).toBe(0);
  });
}

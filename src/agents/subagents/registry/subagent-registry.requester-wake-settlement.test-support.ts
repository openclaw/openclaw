import { expect, it, vi } from "vitest";
import { createSubagentRunParams } from "../../subagent-test-fixtures.test-helpers.js";
import { createSessionsYieldTool } from "../../tools/sessions-yield-tool.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import type { GatewayRequest } from "./subagent-registry.lifecycle-fixture.test-support.js";
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
    registry.addSubagentRunForTests({
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
    registry.addSubagentRunForTests({
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
    await createSessionsYieldTool({
      sessionId: "sess-main",
      claimYield: () =>
        registry.markRequesterTurnYielded({
          requesterSessionKey,
          requesterAgentId: "main",
          requesterTurnRunId,
        }) > 0,
      onYield: () => {},
    }).execute("yield-current-result", {});
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

  it("caps a stale requester batch despite foreign active work in a global session", async () => {
    vi.setSystemTime(100_000);
    useGlobalSessionScope();
    registry.addSubagentRunForTests({
      runId: "run-main-batch",
      childSessionKey: "agent:main:subagent:batch",
      requesterSessionKey,
      requesterDisplayKey: "main",
      requesterAgentId: "main",
      task: "main completed batch",
      cleanup: "keep",
      createdAt: 1_000,
      execution: { status: "terminal", startedAt: 1_100, endedAt: 1_200 },
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
    registry.addSubagentRunForTests({
      runId: "run-main-stale",
      childSessionKey: "agent:main:subagent:stale",
      requesterSessionKey,
      requesterDisplayKey: "main",
      requesterAgentId: "main",
      task: "main stale settle blocker",
      cleanup: "keep",
      createdAt: 2_000,
      execution: { status: "terminal", startedAt: 2_100, endedAt: 2_200 },
      expectsCompletionMessage: true,
      delivery: { status: "pending" },
    });
    registry.addSubagentRunForTests({
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

    const batch = registry.getSubagentRunByRunId("run-main-batch");
    if (!batch) {
      throw new Error("expected main requester batch");
    }
    const transitions: Array<{ deferralCount?: number; nextAttemptAt?: number }> = [];
    const completions: Array<{ delivered: boolean; error?: string }> = [];
    const runWake = () =>
      maybeWakeRequesterAfterAllChildrenSettled({
        requesterSessionKey,
        settledEntry: batch,
        transitionBatch: (_runIds, state) => {
          transitions.push({
            deferralCount: state.deferralCount,
            nextAttemptAt: state.nextAttemptAt,
          });
          batch.requesterSettleWake = { ...state };
        },
        completeBatch: (_runIds, _rearmGeneration, outcome) => {
          if (outcome) {
            completions.push({ delivered: outcome.delivered, error: outcome.error });
          }
          batch.requesterSettleWake = undefined;
        },
      });

    await expect(runWake()).resolves.toBe(false);
    expect(transitions).toEqual([{ deferralCount: 9, nextAttemptAt: 130_000 }]);
    expect(completions).toEqual([]);

    await expect(runWake()).resolves.toBe(false);
    expect(transitions).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(runWake()).resolves.toBe(false);
    expect(completions).toEqual([
      {
        delivered: false,
        error: "requester settle wake deferred too many times",
      },
    ]);
    expect(batch.requesterSettleWake).toBeUndefined();
    expect(registry.countActiveDescendantRuns(requesterSessionKey)).toBe(1);
    expect(registry.countActiveDescendantRuns(requesterSessionKey, "main")).toBe(0);
  });
}

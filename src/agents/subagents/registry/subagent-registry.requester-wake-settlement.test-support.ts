import { expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import type { onAgentEvent } from "../../../infra/agent-events.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { createSubagentRunParams } from "../../subagent-test-fixtures.test-helpers.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import { mutateRequesterCompletionBatch } from "../completion/subagent-completion-admission.store.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { buildScopedSubagentRunReadIndexFromRuns } from "./subagent-registry-queries.js";
import type { GatewayRequest } from "./subagent-registry.lifecycle-fixture.test-support.js";
import {
  createRequesterYieldTool,
  visibleChild,
} from "./subagent-registry.requester-wake-receipts.test-support.js";
import * as registry from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerRequesterWakeSettlementBoundaryTests({
  requesterSessionKey,
  spawnVisibleChild,
  emitCompleted,
  flushOwnedWork,
  waitForDeliveredCleanup,
  getRequesterWakeCalls,
  getAgentCalls,
  getGatewayContext,
  getLifecycleHandler,
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
  getAgentCalls: () => GatewayRequest[];
  getGatewayContext: () => GatewayRequestContext;
  getLifecycleHandler: () => Parameters<typeof onAgentEvent>[0] | undefined;
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
  it("delivers after its owned descendant settles despite foreign active work in a global session", async () => {
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

    const transitions: Array<{ status: string; attemptCount: number }> = [];
    const waits: Array<number | undefined> = [];
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
        onDescendantsPending: (deadline) => waits.push(deadline),
        transitionBatch: async (entries, state, onPublished) => {
          const publication = await mutateRequesterCompletionBatch({
            entries,
            operation: { kind: "transition", state },
            context: captureOpenClawStateWorkerContext(),
            assertCurrent: () => {},
            onCommitted: () => {},
            onPublished: () =>
              onPublished?.(entries.map((entry) => subagentRuns.get(entry.runId)!)),
          });
          expect(publication).toEqual({ applied: true, publication: "published" });
          transitions.push({
            status: state.status,
            attemptCount: state.attemptCount,
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
    expect(transitions).toEqual([]);
    expect(waits).toEqual([302_200]);
    expect(completions).toEqual([]);

    // Descendant settlement makes this recorded cohort runnable. Foreign work
    // sharing the logical key still cannot hold this physical requester's wake.
    await mutateSubagentRuns(["run-main-stale"], (rows) => {
      const stale = rows.get("run-main-stale");
      if (!stale) {
        throw new Error("expected the owned descendant");
      }
      const settled: SubagentRunRecord = {
        ...stale,
        delivery: { status: "delivered", disposition: "delivered" },
        cleanupCompletedAt: Date.now(),
      };
      return {
        value: undefined,
        postimages: new Map([[stale.runId, settled]]),
      };
    });
    await expect(runWake()).resolves.toBe(true);
    expect(transitions).toEqual([{ status: "dispatching", attemptCount: 1 }]);
    expect(getRequesterWakeCalls()).toHaveLength(1);
    expect(completions).toEqual([{ delivered: true, error: undefined }]);
    expect(registry.getSubagentRunByRunId("run-main-batch")?.requesterSettleWake).toBeUndefined();
    expect(
      buildScopedSubagentRunReadIndexFromRuns(
        subagentRuns,
        requesterSessionKey,
      ).countActiveDescendantRuns(requesterSessionKey),
    ).toBe(1);
    expect(
      buildScopedSubagentRunReadIndexFromRuns(
        subagentRuns,
        requesterSessionKey,
        "main",
      ).countActiveDescendantRuns(requesterSessionKey),
    ).toBe(0);
  });

  it("wakes a yielded parent once after one running child is stopped", async () => {
    await registry.initSubagentRegistry();
    await registry.activateSubagentRegistry(getGatewayContext);
    const { withLocalSessionPlacementTurnSettlement } =
      await import("../../session-placement-admission.js");
    const requesterTurnRunId = "requester-stopped-pair";
    const stopped = visibleChild("stopped");
    const finished = visibleChild("finished");
    for (const child of [stopped, finished]) {
      await spawnVisibleChild({ ...child, requesterTurnRunId });
    }
    await createRequesterYieldTool(requesterSessionKey, requesterTurnRunId).execute(
      "yield-stopped-pair",
      {},
    );
    await withLocalSessionPlacementTurnSettlement(
      {
        sessionId: "sess-main",
        sessionKey: requesterSessionKey,
        agentId: "main",
        runId: requesterTurnRunId,
      },
      async () => ({
        payloads: [],
        acceptedSessionSpawns: [stopped, finished],
        meta: {
          durationMs: 1,
          yielded: true,
          executionTrace: { runner: "cli", attempts: [], fallbackUsed: false },
        },
      }),
    );
    const lifecycleHandler = getLifecycleHandler();
    if (!lifecycleHandler) {
      throw new Error("Fixture lifecycle listener was not registered before Stop");
    }
    lifecycleHandler({
      stream: "lifecycle",
      runId: stopped.runId,
      seq: 1,
      ts: Date.now(),
      sessionKey: stopped.childSessionKey,
      data: { phase: "end", endedAt: Date.now(), aborted: true, stopReason: "aborted" },
    });
    await flushOwnedWork();
    expect(getRequesterWakeCalls()).toHaveLength(0);
    expect(registry.getSubagentRunByRunId(stopped.runId)).toMatchObject({
      endedReason: "subagent-killed",
      suppressCompletionDelivery: true,
    });

    emitCompleted(finished.runId, finished.childSessionKey, "finished sibling findings");
    await flushOwnedWork();
    expect(getRequesterWakeCalls()).toHaveLength(1);
    const wake = String(getRequesterWakeCalls()[0]?.params?.message);
    expect(wake).toContain("finished sibling findings");
    expect(wake).toMatch(
      /run-stopped\n<\/prompt-data>\nstatus: cancelled[^\n]*\n[^\n]*\n<prompt-data>\n\(no output\)/,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await registry.testing.sweepOnceForTests();
    await flushOwnedWork();
    expect(getAgentCalls()).toHaveLength(1);
    expect(registry.getSubagentRunByRunId(finished.runId)?.requesterSettleWake).toBeUndefined();
    expect(registry.getSubagentRunByRunId(stopped.runId)).toBeUndefined();
  });
}

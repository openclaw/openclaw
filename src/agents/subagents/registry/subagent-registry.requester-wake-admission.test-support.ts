import { expect, it, vi } from "vitest";
import * as sessionAccessor from "../../../config/sessions/session-accessor.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { WorkerTaskError } from "../../../infra/worker-task-pool.js";
import {
  assertAgentDatabaseAdmitted,
  createAgentDatabaseInspectionRefusal,
  recordAgentDatabaseAdmissions,
} from "../../../state/agent-database-admission.js";
import type { OpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import type {
  GatewayRequest,
  SessionStoreEntry,
} from "./subagent-registry.lifecycle-fixture.test-support.js";
import type { PrepareRequesterWakeChildSession } from "./subagent-registry.requester-wake-session.test-support.js";
import * as registry from "./subagent-registry.test-helpers.js";

export function registerRequesterStartupAdmissionTests({
  requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
  prepareChildSession,
  getFixture,
  createGatewayContext,
  flushOwnedWork,
  getRequesterWakeCalls,
  wakeRequester,
}: {
  requesterSessionKey: string;
  prepareChildSession: PrepareRequesterWakeChildSession;
  getFixture: () => {
    testState: OpenClawTestState;
    sessionStore: Record<string, SessionStoreEntry>;
    sessionStorePath: string;
  };
  createGatewayContext: () => GatewayRequestContext;
  flushOwnedWork: () => Promise<void>;
  getRequesterWakeCalls: () => GatewayRequest[];
  wakeRequester: typeof maybeWakeRequesterAfterAllChildrenSettled;
}) {
  it.each(["retry", "cancel", "replace"] as const)(
    "preserves a saved wake through worker capacity preparation (%s)",
    async (outcome) => {
      vi.setSystemTime(100_000);
      const runId = "preparation-child";
      const childSessionKey = `agent:main:subagent:${runId}`;
      const { sessionId, lifecycleRevision } = await prepareChildSession(childSessionKey, runId, 1);
      await registry.addSubagentRunForTests({
        runId,
        childSessionKey,
        childSessionIdentity: { sessionId, lifecycleRevision },
        requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
        requesterAgentId: "main",
        requesterDisplayKey: "main",
        task: "Finish the retained request",
        cleanup: "keep",
        createdAt: 1_000,
        execution: {
          status: "terminal",
          startedAt: 2_000,
          endedAt: 3_000,
          outcome: { status: "ok" },
        },
        expectsCompletionMessage: true,
        completion: {
          required: true,
          terminalReply: { disposition: "visible", text: "old result" },
          capturedAt: 3_000,
        },
        delivery: { status: "delivered" },
        requesterSettleWake: {
          status: "pending",
          attemptCount: 0,
          replayCount: 0,
          deferralCount: 2,
          batchRunIds: [runId],
          requesterYieldBatch: true,
          rearmGeneration: 1,
          progressOperationId: "original-progress",
          retireAfterSettle: true,
        },
      });
      const original = registry.getSubagentRunByRunId(runId)!;
      const read = vi
        .spyOn(sessionAccessor, "findTranscriptEvent")
        .mockRejectedValueOnce(new WorkerTaskError("worker task capacity reached", "overloaded"))
        .mockResolvedValue(undefined);
      const context = createGatewayContext();
      await registry.initSubagentRegistry();
      await registry.activateSubagentRegistry(() => context);
      await flushOwnedWork();
      expect(read).toHaveBeenCalled();
      expect(getRequesterWakeCalls()).toHaveLength(0);
      const retained = registry.getSubagentRunByRunId(runId)!;
      expect(retained.requesterSettleWake).toEqual({
        ...original.requesterSettleWake,
        nextAttemptAt: 130_000,
      });
      expect(retained.delivery).toEqual(original.delivery);
      expect(retained.suppressCompletionDelivery).not.toBe(true);

      if (outcome === "cancel") {
        await registry.cancelSubagentRequesterSettleWake(retained, () => {});
      } else if (outcome === "replace") {
        await registry.addSubagentRunForTests({
          ...retained,
          generation: (retained.generation ?? 0) + 1,
          completion: {
            ...retained.completion!,
            terminalReply: { disposition: "visible", text: "replacement result" },
          },
          requesterSettleWake: undefined,
        });
      } else {
        // Reopen the registry to prove retry custody and deadline were persisted.
        await registry.resetSubagentRegistryForTests({ persist: false });
        await registry.initSubagentRegistry();
        await registry.activateSubagentRegistry(() => context);
        await flushOwnedWork();
        expect(getRequesterWakeCalls()).toHaveLength(0);
      }
      await vi.advanceTimersByTimeAsync(30_000);
      await flushOwnedWork();
      const wakes = getRequesterWakeCalls();
      expect(wakes).toHaveLength(outcome === "retry" ? 1 : 0);
      if (outcome === "retry") {
        expect(wakes[0]?.params?.idempotencyKey).toBe(
          `announce:requester-settle:main:${MAIN_REQUESTER_SESSION_KEY}:${runId}:yield-1`,
        );
        expect(wakes[0]?.params?.message).toContain("old result");
        expect(registry.getSubagentRunByRunId(runId)).toBeUndefined();
      } else if (outcome === "cancel") {
        expect(registry.getSubagentRunByRunId(runId)?.requesterSettleWake).toBeUndefined();
      } else {
        expect(registry.getSubagentRunByRunId(runId)).toMatchObject({
          generation: (retained.generation ?? 0) + 1,
          completion: { terminalReply: { text: "replacement result" } },
        });
        expect(registry.getSubagentRunByRunId(runId)?.requesterSettleWake).toBeUndefined();
      }
      await vi.advanceTimersByTimeAsync(120_000);
      await flushOwnedWork();
      expect(getRequesterWakeCalls()).toHaveLength(wakes.length);
    },
  );

  it("resumes a persisted requester cohort after database startup inspection finishes", async () => {
    const { testState } = getFixture();
    vi.setSystemTime(100_000);
    const runIds = ["restored-alpha", "restored-beta"];
    for (const runId of runIds) {
      const childSessionKey = `agent:main:subagent:${runId}`;
      const { sessionId, lifecycleRevision } = await prepareChildSession(childSessionKey, runId, 1);
      await registry.addSubagentRunForTests({
        runId,
        childSessionKey,
        childSessionIdentity: { sessionId, lifecycleRevision },
        requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
        requesterAgentId: "main",
        requesterDisplayKey: "main",
        task: "Finish the retained request",
        cleanup: "keep",
        createdAt: 1_000,
        execution: {
          status: "terminal",
          startedAt: 2_000,
          endedAt: 3_000,
          outcome: { status: "ok" },
        },
        expectsCompletionMessage: true,
        completion: { required: true, resultText: `${runId} findings`, capturedAt: 3_000 },
        delivery: { status: "delivered" },
        cleanupCompletedAt: 3_000,
        requesterSettleWake: {
          status: "pending",
          attemptCount: 0,
          batchRunIds: runIds,
          requesterYieldBatch: true,
          rearmGeneration: 1,
          progressOperationId: runId,
          ...(runId === runIds[0] ? { retireAfterSettle: true } : {}),
        },
      });
    }
    await registry.resetSubagentRegistryForTests({ persist: false });
    const pending = createAgentDatabaseInspectionRefusal({
      agentId: "main",
      paths: [testState.statePath("agents", "main", "agent", "openclaw-agent.sqlite")],
      pending: true,
      reason: "Startup inspection has not finished",
    });
    recordAgentDatabaseAdmissions([pending], { source: "startup" });
    // This suite supplies session reads; enforce their real admission boundary
    // while the actual registry, durable transitions, and retry timers run.
    vi.mocked(maybeWakeRequesterAfterAllChildrenSettled).mockImplementation((params) => {
      assertAgentDatabaseAdmitted("main");
      return wakeRequester(params);
    });
    try {
      await registry.initSubagentRegistry();
      const firstContext = createGatewayContext();
      await registry.activateSubagentRegistry(() => firstContext);
      await flushOwnedWork();
      expect(getRequesterWakeCalls()).toHaveLength(0);
      for (const runId of runIds) {
        expect(registry.getSubagentRunByRunId(runId)?.requesterSettleWake).toMatchObject({
          status: "pending",
          attemptCount: 0,
          batchRunIds: runIds,
          rearmGeneration: 1,
          nextAttemptAt: 130_000,
          progressOperationId: runId,
        });
        expect(registry.getSubagentRunByRunId(runId)?.requesterSettleWake?.retireAfterSettle).toBe(
          runId === runIds[0] ? true : undefined,
        );
      }
      // The backoff is durable: another restart must neither consume the result
      // nor dispatch the parent before its database can admit the original wake.
      await registry.resetSubagentRegistryForTests({ persist: false });
      await registry.initSubagentRegistry();
      const context = createGatewayContext();
      await registry.activateSubagentRegistry(() => context);
      recordAgentDatabaseAdmissions([], { source: "startup" });
      await vi.advanceTimersByTimeAsync(30_000);
      await flushOwnedWork();
      expect(getRequesterWakeCalls()).toHaveLength(1);
      expect(registry.getSubagentRunByRunId(runIds[0]!)).toBeUndefined();
      expect(registry.getSubagentRunByRunId(runIds[1]!)).toBeDefined();
      for (const runId of runIds) {
        expect(registry.getSubagentRunByRunId(runId)?.requesterSettleWake).toBeUndefined();
      }
    } finally {
      recordAgentDatabaseAdmissions([], { source: "startup" });
    }
  });
}

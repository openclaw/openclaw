import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import * as sessionAccessor from "../../../config/sessions/session-accessor.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { WorkerTaskError } from "../../../infra/worker-task-pool.js";
import {
  assertAgentDatabaseAdmitted,
  createAgentDatabaseInspectionRefusal,
  recordAgentDatabaseAdmissions,
} from "../../../state/agent-database-admission.js";
import type { OpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import * as descendants from "../announce/subagent-announce.requester-settle-descendants.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import * as completionStore from "../completion/subagent-completion-admission.store.js";
import type {
  GatewayRequest,
  SessionStoreEntry,
} from "./subagent-registry.lifecycle-fixture.test-support.js";
import * as registry from "./subagent-registry.test-helpers.js";

export function registerRequesterStartupAdmissionTests({
  requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
  getFixture,
  createGatewayContext,
  flushOwnedWork,
  getRequesterWakeCalls,
  wakeRequester,
}: {
  requesterSessionKey: string;
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
  it.each([
    { failure: "result changed", outcome: "retry" },
    { failure: "result changed after read", outcome: "retry" },
    { failure: "result changed during reservation", outcome: "retry" },
    { failure: "worker capacity", outcome: "retry" },
    { failure: "result changed", outcome: "cancel" },
    { failure: "worker capacity", outcome: "replace" },
  ] as const)(
    "preserves a saved wake through $failure preparation ($outcome)",
    async ({ failure, outcome }) => {
      vi.setSystemTime(100_000);
      const { sessionStore, sessionStorePath } = getFixture();
      const runId = "preparation-child";
      const childSessionKey = `agent:main:subagent:${runId}`;
      sessionStore[childSessionKey] = { sessionId: runId, updatedAt: 1 };
      await replaceSessionEntry(
        { storePath: sessionStorePath, sessionKey: childSessionKey },
        sessionStore[childSessionKey],
      );
      await registry.addSubagentRunForTests({
        runId,
        childSessionKey,
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
      const changeResult = () => {
        const current = registry.getSubagentRunByRunId(runId)!;
        return registry.addSubagentRunForTests({
          ...current,
          completion: {
            ...current.completion!,
            terminalReply: { disposition: "visible", text: "fresh result" },
          },
        });
      };
      const read = vi
        .spyOn(sessionAccessor, "findTranscriptEvent")
        .mockImplementationOnce(async () => {
          if (failure === "worker capacity") {
            throw new WorkerTaskError("worker task capacity reached", "overloaded");
          }
          if (failure === "result changed") {
            await changeResult();
          }
          return undefined;
        });
      if (failure === "result changed after read") {
        const createReader = descendants.createRequesterDescendantReader;
        let changed = false;
        vi.spyOn(descendants, "createRequesterDescendantReader").mockImplementation((params) => {
          const readDescendants = createReader(params);
          let reads = 0;
          return async () => {
            const result = await readDescendants();
            if (++reads === 2 && !changed) {
              changed = true;
              await changeResult();
            }
            return result;
          };
        });
      }
      if (failure === "result changed during reservation") {
        const mutate = vi
          .mocked(completionStore.mutateRequesterCompletionBatch)
          .getMockImplementation();
        assert(
          mutate,
          "Requester preparation observation requires its registered settlement fixture",
        );
        let changed = false;
        vi.spyOn(completionStore, "mutateRequesterCompletionBatch").mockImplementation(
          async (params) => {
            const result = await mutate(params);
            if (
              params.operation.kind === "transition" &&
              params.operation.state.status === "dispatching" &&
              !changed
            ) {
              changed = true;
              await changeResult();
            }
            return result;
          },
        );
      }
      // Read current captured output on retry without depending on a transcript fixture.
      read.mockResolvedValue(undefined);
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
        expect(wakes[0]?.params?.message).toContain(
          failure === "worker capacity" ? "old result" : "fresh result",
        );
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
    const { testState, sessionStore, sessionStorePath } = getFixture();
    vi.setSystemTime(100_000);
    const runIds = ["restored-alpha", "restored-beta"];
    for (const runId of runIds) {
      const childSessionKey = `agent:main:subagent:${runId}`;
      sessionStore[childSessionKey] = { sessionId: runId, updatedAt: 1 };
      await replaceSessionEntry(
        { storePath: sessionStorePath, sessionKey: childSessionKey },
        sessionStore[childSessionKey],
      );
      await registry.addSubagentRunForTests({
        runId,
        childSessionKey,
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

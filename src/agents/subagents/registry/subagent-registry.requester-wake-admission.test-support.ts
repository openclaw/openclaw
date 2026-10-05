import { expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
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

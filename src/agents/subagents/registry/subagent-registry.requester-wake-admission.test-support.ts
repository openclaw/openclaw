import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import * as sessionAccessor from "../../../config/sessions/session-accessor.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { resolveRuntimeWorkerUrl } from "../../../infra/runtime-worker-url.js";
import { workerTaskPoolEntrypoints } from "../../../infra/worker-task-pool-runtime.test-support.js";
import { WorkerTaskPool } from "../../../infra/worker-task-pool.js";
import {
  getExistingSessionControllerMailbox,
  retireSessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import { captureSessionTarget } from "../../../sessions/session-controller.target.js";
import {
  assertAgentDatabaseAdmitted,
  recordAgentDatabaseAdmissions,
} from "../../../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../../../state/agent-database-startup.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import type { OpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import type {
  GatewayRequest,
  SessionStoreEntry,
} from "./subagent-registry.lifecycle-fixture.test-support.js";
import { prepareSubagentRecoveryFixture } from "./subagent-registry.persistence.test-support.js";
import type { PrepareRequesterWakeChildSession } from "./subagent-registry.requester-wake-session.test-support.js";
import * as registry from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function holdWorkerCapacity() {
  const pool = new WorkerTaskPool<void, undefined>({
    workerUrl: resolveRuntimeWorkerUrl(workerTaskPoolEntrypoints.worker),
    maxWorkers: 1,
    maxPendingTasks: 1,
  });
  const preparation = createDeferred();
  const controller = new AbortController();
  // Hold input preparation so the real pool rejects excess work without spawning a worker.
  const held = Promise.allSettled([
    pool.run(() => preparation.promise, { signal: controller.signal }),
  ]);
  const release = async () => {
    controller.abort();
    preparation.resolve();
    await held;
  };
  return {
    pool,
    release,
    async [Symbol.asyncDispose]() {
      try {
        await release();
      } finally {
        await pool.close();
      }
    },
  };
}

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
      const recovered: SubagentRunRecord = {
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
          batchRunIds: [runId],
          requesterYieldBatch: true,
          rearmGeneration: 1,
          progressOperationId: "original-progress",
          retireAfterSettle: true,
        },
      };
      const { sessionStore, sessionStorePath } = getFixture();
      await prepareSubagentRecoveryFixture(recovered, {
        entries: sessionStore,
        storePath: sessionStorePath,
      });
      await registry.addSubagentRunForTests(recovered);
      const original = registry.getSubagentRunByRunId(runId)!;
      await using capacity = holdWorkerCapacity();
      const read = vi
        .spyOn(sessionAccessor, "findTranscriptEvent")
        .mockImplementation(() => capacity.pool.run(undefined, {}));
      const context = createGatewayContext();
      await registry.initSubagentRegistry();
      await registry.activateSubagentRegistry(() => context);
      const source = getExistingSessionControllerMailbox(
        MAIN_REQUESTER_SESSION_KEY,
        captureSessionTarget({
          storeScope: sessionStorePath,
          sessionKey: MAIN_REQUESTER_SESSION_KEY,
        }),
      )?.entries.find(
        (input) =>
          input.sourceTurnId ===
          `requester-settle:main:${MAIN_REQUESTER_SESSION_KEY}:${runId}:yield-1`,
      );
      expect(source).toBeDefined();
      // Raw row replacement leaves this fixture's original reservation for its owner to retire.
      onTestFinished(() => source && retireSessionControllerInput(source));
      await flushOwnedWork();
      expect(read).toHaveBeenCalled();
      expect(getRequesterWakeCalls()).toHaveLength(0);
      const retained = registry.getSubagentRunByRunId(runId)!;
      expect(retained.requesterSettleWake).toEqual(original.requesterSettleWake);
      expect(retained.delivery).toEqual(original.delivery);
      expect(retained.suppressCompletionDelivery).not.toBe(true);
      await vi.advanceTimersByTimeAsync(30_000);
      await flushOwnedWork();
      expect(getRequesterWakeCalls()).toHaveLength(0);

      if (outcome === "cancel") {
        await registry.retireSubagentObligations(retained, () => {}, { requesterNotified: true });
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
        // Reopen while capacity is still held: durable custody survives, readiness stays pool-owned.
        await registry.resetSubagentRegistryForTests({ persist: false });
        await registry.initSubagentRegistry();
        await registry.activateSubagentRegistry(() => context);
        await flushOwnedWork();
        expect(getRequesterWakeCalls()).toHaveLength(0);
        expect(registry.getSubagentRunByRunId(runId)?.requesterSettleWake).toEqual(
          original.requesterSettleWake,
        );
      }
      read.mockResolvedValue(undefined);
      await capacity.release();
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
      const recovered: SubagentRunRecord = {
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
      };
      const { sessionStore, sessionStorePath } = getFixture();
      await prepareSubagentRecoveryFixture(recovered, {
        entries: sessionStore,
        storePath: sessionStorePath,
      });
      await registry.addSubagentRunForTests(recovered);
    }
    await registry.resetSubagentRegistryForTests({ persist: false });
    const pathname = openOpenClawAgentDatabase({ agentId: "main" }).path;
    await withAgentDatabaseStartupAdmission(async (admission) => {
      const inspection = createDeferred<{ incompatible: []; indeterminate: [] }>();
      recordAgentDatabaseAdmissions(
        admission.defer({
          env: testState.env,
          inspections: [
            { target: { agentId: "main", path: pathname }, result: inspection.promise },
          ],
          reason: "Requester fixture is waiting for startup inspection.",
        }),
        { env: testState.env, source: "startup" },
      );
      const owner = admission.adopt();
      admission.activate({
        isCurrent: () => true,
        preparationReady: Promise.resolve(),
        openAgent: async () => {
          openOpenClawAgentDatabase({ agentId: "main" });
        },
        migrateAgent: async () => {},
        publishAgent: async () => {},
      });
      // Session reads are supplied by this suite; retain their real startup admission boundary.
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
        const retained = runIds.map(
          (runId) => registry.getSubagentRunByRunId(runId)?.requesterSettleWake,
        );
        for (const [index, runId] of runIds.entries()) {
          expect(retained[index]).toEqual({
            status: "pending",
            attemptCount: 0,
            batchRunIds: runIds,
            requesterYieldBatch: true,
            rearmGeneration: 1,
            progressOperationId: runId,
            ...(index === 0 ? { retireAfterSettle: true } : {}),
          });
        }
        // A restart preserves the cohort without admitting work or consuming a timed retry.
        await registry.resetSubagentRegistryForTests({ persist: false });
        await registry.initSubagentRegistry();
        const context = createGatewayContext();
        await registry.activateSubagentRegistry(() => context);
        await vi.advanceTimersByTimeAsync(30_000);
        await flushOwnedWork();
        expect(getRequesterWakeCalls()).toHaveLength(0);
        expect(
          runIds.map((runId) => registry.getSubagentRunByRunId(runId)?.requesterSettleWake),
        ).toEqual(retained);
        const prepared = admission.waitForAgentPreparation("main", { env: testState.env });
        expect(prepared).toBeDefined();
        inspection.resolve({ incompatible: [], indeterminate: [] });
        await prepared;
        await flushOwnedWork();
        expect(getRequesterWakeCalls()).toHaveLength(1);
        expect(registry.getSubagentRunByRunId(runIds[0]!)).toBeUndefined();
        expect(registry.getSubagentRunByRunId(runIds[1]!)).toBeDefined();
        for (const runId of runIds) {
          expect(registry.getSubagentRunByRunId(runId)?.requesterSettleWake).toBeUndefined();
        }
        await vi.advanceTimersByTimeAsync(120_000);
        await flushOwnedWork();
        expect(getRequesterWakeCalls()).toHaveLength(1);
      } finally {
        inspection.resolve({ incompatible: [], indeterminate: [] });
        await owner.stop();
      }
    });
  });
}

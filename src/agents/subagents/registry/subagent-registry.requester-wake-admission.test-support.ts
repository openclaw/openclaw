import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
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
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import * as deliveryRuntime from "../announce/subagent-announce-delivery.runtime.js";
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
  const readWake = (runId: string) => registry.getSubagentRunByRunId(runId)?.requesterSettleWake;
  const advance = async (ms: number, count: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    await flushOwnedWork();
    expect(getRequesterWakeCalls()).toHaveLength(count);
  };
  const activate = async (context?: GatewayRequestContext) => {
    await registry.initSubagentRegistry();
    const activeContext = context ?? createGatewayContext();
    await registry.activateSubagentRegistry(() => activeContext);
  };
  async function restoreChild(runId: string, overrides: Partial<SubagentRunRecord>) {
    const childSessionKey = `agent:main:subagent:${runId}`;
    const { sessionId, lifecycleRevision } = await prepareChildSession(childSessionKey, runId, 1);
    const recovered = createSubagentRunRecord({
      runId,
      childSessionKey,
      childSessionIdentity: { sessionId, lifecycleRevision },
      requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
      requesterAgentId: "main",
      createdAt: 1_000,
      startedAt: 2_000,
      endedAt: 3_000,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
      delivery: { status: "delivered" },
      ...overrides,
    });
    const { sessionStore, sessionStorePath } = getFixture();
    await prepareSubagentRecoveryFixture(recovered, {
      entries: sessionStore,
      storePath: sessionStorePath,
    });
    await registry.addSubagentRunForTests(recovered);
  }
  function pendingWake(
    runId: string,
    batchRunIds = [runId],
  ): NonNullable<SubagentRunRecord["requesterSettleWake"]> {
    return {
      status: "pending" as const,
      attemptCount: 0,
      batchRunIds,
      requesterYieldBatch: true,
      rearmGeneration: 1,
      progressOperationId: runId,
    };
  }
  it.each(["retry", "cancel", "replace"] as const)(
    "preserves a saved wake through worker capacity preparation (%s)",
    async (outcome) => {
      vi.setSystemTime(100_000);
      const runId = "preparation-child";
      await restoreChild(runId, {
        completion: {
          required: true,
          terminalReply: { disposition: "visible", text: "old result" },
          capturedAt: 3_000,
        },
        requesterSettleWake: {
          ...pendingWake(runId),
          replayCount: 0,
          progressOperationId: "original-progress",
          retireAfterSettle: true,
        },
      });
      const { sessionStorePath } = getFixture();
      const original = registry.getSubagentRunByRunId(runId)!;
      await using capacity = holdWorkerCapacity();
      const captureRequester = deliveryRuntime.captureRequesterSessionEntryCurrent;
      const read = vi
        .spyOn(deliveryRuntime, "captureRequesterSessionEntryCurrent")
        .mockImplementation(async (...args) => {
          await capacity.pool.run(undefined, {});
          return captureRequester(...args);
        });
      const context = createGatewayContext();
      await activate(context);
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
      await advance(30_000, 0);

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
        await activate(context);
        await flushOwnedWork();
        expect(getRequesterWakeCalls()).toHaveLength(0);
        expect(readWake(runId)).toEqual(original.requesterSettleWake);
      }
      read.mockRestore();
      await capacity.release();
      await flushOwnedWork();
      const wakes = getRequesterWakeCalls();
      expect(wakes).toHaveLength(outcome === "retry" ? 1 : 0);
      if (outcome === "retry") {
        expect(wakes[0]?.params?.idempotencyKey).toBe(
          `announce:requester-settle:main:${MAIN_REQUESTER_SESSION_KEY}:${runId}:yield-1`,
        );
        expect(wakes[0]?.params?.message).toContain("Already delivered child results");
        expect(wakes[0]?.params?.message).not.toContain("old result");
        expect(registry.getSubagentRunByRunId(runId)).toBeUndefined();
      } else if (outcome === "cancel") {
        expect(readWake(runId)).toBeUndefined();
      } else {
        expect(registry.getSubagentRunByRunId(runId)).toMatchObject({
          generation: (retained.generation ?? 0) + 1,
          completion: { terminalReply: { text: "replacement result" } },
        });
        expect(readWake(runId)).toBeUndefined();
      }
      await advance(120_000, wakes.length);
    },
  );

  it("resumes a persisted requester cohort after database startup inspection finishes", async () => {
    const { testState } = getFixture();
    vi.setSystemTime(100_000);
    const runIds = ["restored-alpha", "restored-beta"];
    const expectedWakes = runIds.map((runId, index) => ({
      ...pendingWake(runId, runIds),
      ...(index === 0 ? { retireAfterSettle: true } : {}),
    }));
    for (const [index, runId] of runIds.entries()) {
      await restoreChild(runId, {
        completion: { required: true, resultText: `${runId} findings`, capturedAt: 3_000 },
        cleanupCompletedAt: 3_000,
        requesterSettleWake: structuredClone(expectedWakes[index]),
      });
    }
    await registry.resetSubagentRegistryForTests({ persist: false });
    const pathname = openOpenClawAgentDatabase({ agentId: "main" }).path;
    for (const restart of [true, false]) {
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
        let activation: Promise<PromiseSettledResult<void>[]> | undefined;
        try {
          await registry.initSubagentRegistry();
          const context = createGatewayContext();
          activation = Promise.allSettled([registry.activateSubagentRegistry(() => context)]);
          await advance(30_000, 0);
          expect(runIds.map(readWake)).toEqual(expectedWakes);
          if (restart) {
            // Stop the old owner before releasing its gate; reset must not inherit live recovery.
            const stopped = owner.stop();
            inspection.resolve({ incompatible: [], indeterminate: [] });
            await stopped;
            expect(await activation).toMatchObject([
              {
                status: "rejected",
                reason: { name: "AbortError" },
              },
            ]);
          } else {
            const prepared = admission.waitForAgentPreparation("main", { env: testState.env });
            expect(prepared).toBeDefined();
            inspection.resolve({ incompatible: [], indeterminate: [] });
            await prepared;
            expect(await activation).toEqual([{ status: "fulfilled", value: undefined }]);
            await flushOwnedWork();
            expect(getRequesterWakeCalls()).toHaveLength(1);
            expect(registry.getSubagentRunByRunId(runIds[0]!)).toBeUndefined();
            expect(registry.getSubagentRunByRunId(runIds[1]!)).toBeDefined();
            for (const runId of runIds) {
              expect(readWake(runId)).toBeUndefined();
            }
            await advance(120_000, 1);
          }
        } finally {
          const stopped = owner.stop();
          inspection.resolve({ incompatible: [], indeterminate: [] });
          await stopped;
          await activation;
        }
      });
      if (restart) {
        await registry.resetSubagentRegistryForTests({ persist: false });
      }
    }
  });
}

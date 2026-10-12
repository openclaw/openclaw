/**
 * Restored-collector rehydration cases for the registry seam suite: FIFO queue
 * rehydration after a running owner releases capacity, restored lifecycle
 * settlement, and retried session cleanup before announcing deletion.
 *
 * Extracted from subagent-registry.test.ts so that file stays under its line
 * cap; the owning suite hands in its mock state and harness accessors.
 */
import { expect, it } from "vitest";
import { createSubagentRunRecord, waitForFast } from "../../subagent-test-fixtures.test-helpers.js";
import { releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import {
  registerRestoredRollbackPublicationTest,
  registerRestoredRotationFailureTest,
} from "./subagent-registry.restored-settlement.test-support.js";
import {
  makeCompletedCollectorRun,
  makeQueuedRun,
} from "./subagent-registry.run-fixtures.test-support.js";
import type { SubagentRegistrySeamFixture } from "./subagent-registry.seam-fixture.test-support.js";

export function registerRestoredCollectorRehydrationTests(fixture: SubagentRegistrySeamFixture) {
  const {
    getLifecycleHandler,
    getRegistry,
    hydrateAndActivateRegistry,
    mockSingleCollectorConcurrency,
    mocks,
  } = fixture;
  const { mockRestoredRuns } = mocks;
  const registry = () => getRegistry();

  it("rehydrates persisted collector FIFO queues after a running owner releases capacity", async () => {
    const now = Date.now();
    mockSingleCollectorConcurrency();
    const queuedRunOverrides = {
      groupId: "logical-group",
      queuedLaunch: {
        authorization: { modelOverride: { provider: "openai", model: "gpt-5.4" } },
        maxConcurrent: 2,
      },
    };
    mockRestoredRuns(() => [
      createSubagentRunRecord({
        runId: "run-active",
        childSessionKey: "agent:main:subagent:run-active",
        groupId: "logical-group",
        collect: true,
        schedulerSlotId: "slot-active",
        createdAt: now - 1_000,
        execution: { status: "running", startedAt: now - 1_000 },
      }),
      makeQueuedRun({ ...queuedRunOverrides, runId: "run-queued-one", createdAt: now }),
      makeQueuedRun({
        ...queuedRunOverrides,
        runId: "run-queued-two",
        createdAt: now + 1,
      }),
    ]);
    mocks.entries = {
      "agent:main:subagent:run-active": {
        sessionId: "session-active",
        updatedAt: now,
      },
      "agent:main:subagent:run-queued-one": { sessionId: "session-one", updatedAt: now },
      "agent:main:subagent:run-queued-two": { sessionId: "session-two", updatedAt: now },
    };
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        return { runId: "gateway-run-one" };
      }
      return request.method === "agent.wait" ? { status: "pending" } : {};
    });

    await hydrateAndActivateRegistry();
    await Promise.resolve();
    expect(mocks.callGateway.mock.calls.filter(([request]) => request.method === "agent")).toEqual(
      [],
    );

    expect(releaseSwarmRun("slot-active")).toBe(true);
    await waitForFast(() => {
      const agentCalls = mocks.callGateway.mock.calls.filter(
        ([request]) => request.method === "agent",
      );
      expect(agentCalls).toHaveLength(1);
      expect(agentCalls[0]?.[0]).toMatchObject({
        params: {
          idempotencyKey: "run-queued-one",
          provider: "openai",
          model: "gpt-5.4",
        },
        scopes: ["operator.admin"],
      });
      expect(registry().getSubagentRunByRunId("run-queued-one")?.execution?.status).toBe("running");
    });
    const acceptedRun = registry().getSubagentRunByRunId("gateway-run-one");
    expect(acceptedRun).toMatchObject({
      runId: "gateway-run-one",
      swarmRunId: "run-queued-one",
      schedulerSlotId: "run-queued-one",
      execution: { status: "running" },
    });
    expect(acceptedRun).not.toHaveProperty("startedAt");
    expect(acceptedRun?.sessionStartedAt).toBeUndefined();
    expect(acceptedRun?.execution.startedAt).toBeUndefined();
    expect(registry().getSubagentRunByRunId("run-queued-two")?.execution?.status).toBe("queued");
  });

  it.each(["started", "retired", "terminal pending", "terminal stale"] as const)(
    "accepts a collector response only for its current launch: %s",
    async (state) => {
      const runId = "run-acceptance";
      const gatewayRunId = "gateway-acceptance";
      const childSessionKey = "agent:main:subagent:acceptance";
      const startedAt = 12_345;
      if (state === "started" || state === "retired") {
        await registry().registerSubagentRun({
          runId,
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "collector acceptance race",
          cleanup: "keep",
          collect: true,
          groupId: "acceptance-race",
          queued: true,
          expectsCompletionMessage: false,
        });
        if (state === "started") {
          const lifecycleHandler = getLifecycleHandler();
          lifecycleHandler({
            runId,
            seq: 1,
            stream: "lifecycle",
            ts: startedAt,
            data: { phase: "start", startedAt },
          });
          await waitForFast(() =>
            expect(registry().getSubagentRunByRunId(runId)?.execution.startedAt).toBe(startedAt),
          );
        }
      } else {
        await registry().addSubagentRunForTests(
          makeCompletedCollectorRun({
            runId,
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "terminal collector acceptance",
            cleanup: "keep",
            swarmRunId: runId,
            schedulerSlotId: runId,
            ...(state === "terminal pending"
              ? {
                  swarmLaunchPending: false,
                  queuedLaunch: {
                    request: { sessionKey: childSessionKey },
                    timeoutMs: 1_000,
                    schedulerGroupKey: "acceptance-race",
                    maxConcurrent: 1,
                  },
                }
              : {}),
            groupId: "acceptance-race",
            createdAt: 1_000,
            endedAt: 2_000,
            execution: { status: "terminal", endedAt: 2_000 },
            completion: { required: false, resultText: "done", capturedAt: 2_000 },
          }),
        );
      }
      expect(
        await registry().startQueuedSubagentRun(
          runId,
          gatewayRunId,
          state === "retired" ? "retired-generation" : undefined,
        ),
      ).toBe(state === "started" || state === "terminal pending");
      const remapped = registry().getSubagentRunByRunId(gatewayRunId);
      if (state === "started") {
        expect(remapped).toMatchObject({
          sessionStartedAt: startedAt,
          execution: { status: "running", acceptedAt: expect.any(Number), startedAt },
        });
      } else if (state === "terminal pending") {
        expect(registry().getSubagentRunByRunId(runId)).toBe(remapped);
        expect(remapped).toMatchObject({
          runId: gatewayRunId,
          swarmRunId: runId,
          collectorCompletion: { status: "done" },
          swarmLaunchPending: false,
        });
      } else {
        expect(remapped).toBeUndefined();
        expect(registry().getSubagentRunByRunId(runId)).toMatchObject(
          state === "retired"
            ? { execution: { status: "queued" } }
            : { runId, collectorCompletion: { status: "done" } },
        );
      }
    },
  );

  registerRestoredRollbackPublicationTest({
    mocks,
    hydrateAndActivateRegistry,
    mockSingleCollectorConcurrency,
    mockRestoredRuns,
  });

  registerRestoredRotationFailureTest({
    getRegistry,
    mocks,
    hydrateAndActivateRegistry,
    mockSingleCollectorConcurrency,
    mockRestoredRuns,
  });

  it("retries restored collector session cleanup before announcing deletion", async () => {
    const now = Date.now();
    mockRestoredRuns(() => [
      makeQueuedRun({
        runId: "run-queued-cleanup-retry",
        childSessionKey: "agent:main:subagent:queued-cleanup-retry",
        swarmRequesterSessionKey: "agent:main:main",
        task: "retry failed cleanup",
        groupId: "restore-cleanup-retry",
        createdAt: now,
        queuedLaunch: {
          request: { sessionKey: "agent:main:subagent:queued-cleanup-retry" },
        },
      }),
    ]);
    mocks.entries = {
      "agent:main:subagent:queued-cleanup-retry": {
        lifecycleRevision: "revision-queued-cleanup-retry",
        sessionId: "queued-cleanup-retry",
        updatedAt: now,
      },
    };
    let deleteAttempts = 0;
    let releaseDelete: (() => void) | undefined;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        throw new Error("launch failed");
      }
      if (request.method === "sessions.delete") {
        deleteAttempts += 1;
        if (deleteAttempts === 1) {
          throw new Error("delete unavailable");
        }
        return await new Promise<Record<string, unknown>>((resolve) => {
          releaseDelete = () => resolve({});
        });
      }
      return {};
    });

    await hydrateAndActivateRegistry();

    await waitForFast(() =>
      expect(registry().getSubagentRunByRunId("run-queued-cleanup-retry")).toMatchObject({
        execution: { status: "queued" },
      }),
    );
    await waitForFast(() => expect(releaseDelete).toBeTypeOf("function"));
    expect(deleteAttempts).toBe(2);
    expect(mocks.emitSessionLifecycleEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:subagent:queued-cleanup-retry",
        reason: "delete",
      }),
    );
    expect(mocks.onSubagentEnded).not.toHaveBeenCalled();
    expect(
      registry().getSubagentRunByRunId("run-queued-cleanup-retry")?.collectorCompletion,
    ).toBeUndefined();

    releaseDelete?.();
    await waitForFast(() =>
      expect(registry().getSubagentRunByRunId("run-queued-cleanup-retry")).toMatchObject({
        execution: { status: "terminal" },
        collectorCompletion: { status: "failed" },
      }),
    );
    await waitForFast(() =>
      expect(mocks.emitSessionLifecycleEvent).toHaveBeenCalledWith({
        sessionKey: "agent:main:subagent:queued-cleanup-retry",
        reason: "delete",
        parentSessionKey: "agent:main:main",
      }),
    );
    await waitForFast(() =>
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith(
        expect.objectContaining({
          childSessionKey: "agent:main:subagent:queued-cleanup-retry",
          reason: "deleted",
        }),
      ),
    );
  });
}

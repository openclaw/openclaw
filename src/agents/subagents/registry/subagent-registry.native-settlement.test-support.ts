import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import {
  createSessionEntry,
  createSubagentRunRecord,
  mockGatewayMethods,
  waitForFast,
  type SubagentRegistryHarness,
} from "../../subagent-test-fixtures.test-helpers.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerQueuedCollectorLaunchSettlementTest({
  getRegistry,
}: {
  getRegistry: () => SubagentRegistryHarness;
}): void {
  it("keeps an in-flight queued collector pending until launch cleanup settles", async () => {
    const mod = getRegistry();
    const runId = "run-collector-launch-kill";
    await mod.addSubagentRunForTests({
      runId,
      childSessionKey: "agent:main:subagent:launch-kill",
      task: "cancel while gateway launch is unresolved",
      createdAt: Date.now(),
      collect: true,
      swarmRunId: runId,
      schedulerSlotId: runId,
      swarmLaunchPending: true,
      execution: { status: "queued" },
      completion: { required: false },
    });

    const launch = createDeferred();
    const started = createDeferred();
    enqueueSwarmRun({
      groupId: "delayed-acceptance",
      runId,
      maxConcurrent: 1,
      activeRunIds: [],
      start: async () => {
        started.resolve();
        await launch.promise;
      },
      onStartFailure: () => true,
    });
    try {
      await started.promise;
      expect(await mod.markSubagentRunTerminated({ runId, reason: "manual kill" })).toBe(1);
      expect(mod.getSubagentRunByRunId(runId)?.collectorCompletion).toBeUndefined();
      expect(await mod.startQueuedSubagentRun(runId, "gateway-launch-kill")).toBe(false);
      expect(mod.getSubagentRunByRunId("gateway-launch-kill")).toBeUndefined();

      expect(await mod.settleFailedQueuedSubagentLaunch(runId, "launch response lost")).toBe(true);
      expect(mod.getSubagentRunByRunId(runId)?.collectorCompletion).toMatchObject({
        status: "killed",
      });
      await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    } finally {
      launch.resolve();
      await launch.promise;
      releaseSwarmRun(runId);
    }
  });
}

export function registerRestoredRunDeadlineSettlementTests({
  getRegistry,
  mocks,
  hydrateAndActivateRegistry,
}: {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    | "resolveAgentTimeoutMs"
    | "restoreSubagentRunsFromDisk"
    | "callGateway"
    | "runSubagentAnnounceFlow"
  >;
  hydrateAndActivateRegistry: () => Promise<void>;
}): void {
  const findRequesterRun = (runId: string) =>
    getRegistry()
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === runId);
  it("prefers explicit run timeout over late restored agent.wait success", async () => {
    const runId = "run-resumed-late-success";
    const createdAt = Date.parse("2026-03-24T11:59:00Z");
    vi.setSystemTime(createdAt + 61_000);
    mocks.resolveAgentTimeoutMs.mockReturnValue(60_000);
    mocks.restoreSubagentRunsFromDisk.mockImplementation((async (params: {
      runs: Map<string, unknown>;
      mergeOnly?: boolean;
    }) => {
      params.runs.set(
        runId,
        createSubagentRunRecord({
          runId,
          task: "resume after explicit timeout",
          runTimeoutSeconds: 60,
          createdAt,
          startedAt: createdAt,
          sessionStartedAt: createdAt,
        }),
      );
      return 1;
    }) as never);
    mockGatewayMethods(mocks.callGateway, {
      "agent.wait": {
        status: "ok",
        startedAt: createdAt,
        endedAt: createdAt + 61_000,
      },
    });

    const settleRootWork = observeRootWork();
    try {
      await hydrateAndActivateRegistry();

      await waitForFast(() => {
        const completedRun = findRequesterRun(runId);
        expect(completedRun?.execution.endedAt).toBe(createdAt + 60_000);
        expect(completedRun?.execution.outcome).toMatchObject({
          status: "timeout",
          startedAt: createdAt,
          endedAt: createdAt + 60_000,
          elapsedMs: 60_000,
        });
      });
    } finally {
      await settleRootWork();
    }
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });
}

export function registerRestartDrainCompletionSettlementTest({
  getRegistry,
  mocks,
  findRequesterRun,
}: {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<ReturnType<typeof createSubagentRegistryMockState>, "runSubagentAnnounceFlow">;
  findRequesterRun: (runId: string) => SubagentRunRecord | undefined;
}): void {
  it("retries a terminal completion deferred by restart drain", async () => {
    const mod = getRegistry();
    const now = Date.now();
    const runId = "run-terminal-restart-retry";
    await mod.addSubagentRunForTests({
      runId,
      childSessionKey: "agent:main:subagent:terminal-restart-retry",
      task: "deliver terminal completion after restart",
      expectsCompletionMessage: true,
      createdAt: now - 10_000,
      startedAt: now - 9_000,
      endedAt: now - 1_000,
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      outcome: { status: "error", error: "provider interrupted" },
    });

    markGatewayRestartDraining();
    await expect(
      mod.finalizeInterruptedSubagentRun({
        runId,
        error: "provider interrupted",
        endedAt: now - 1_000,
      }),
    ).resolves.toBe(1);
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

    resetGatewayWorkAdmission();
    const settleRootWork = observeRootWork();
    try {
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      await settleRootWork();
    }
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce();
    const entry = findRequesterRun(runId);
    expect(entry?.cleanupCompletedAt).toBeTypeOf("number");
  });
}

export function registerForcedCollectorCompletionSettlementTests({
  getRegistry,
  mocks,
  findRequesterRun,
  getLifecycleHandler,
  mockPendingAgentWait,
}: {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    "entries" | "runSubagentAnnounceFlow"
  >;
  findRequesterRun: (runId: string) => SubagentRunRecord | undefined;
  getLifecycleHandler: () => (event: Pick<AgentEventPayload, "runId" | "stream" | "data">) => void;
  mockPendingAgentWait: () => void;
}): void {
  it("settles forced collector yield through lifecycle with captured structured output", async () => {
    const mod = getRegistry();
    const runId = "forced-collector-yield";
    const childSessionKey = "agent:main:subagent:forced-collector-yield";
    const terminal = {
      status: "ok",
      startedAt: 111,
      endedAt: 222,
      yielded: true,
      livenessState: "paused",
    };
    mockPendingAgentWait();
    mocks.entries = {
      [childSessionKey]: createSessionEntry({ lifecycleRevision: "forced-yield" }),
    };
    const settleRootWork = observeRootWork();
    try {
      await mod.registerSubagentRun({
        runId,
        childSessionKey,
        task: "force the terminal boundary",
        collect: true,
        expectsCompletionMessage: false,
        swarmRequesterSessionKey: "agent:main:main",
        outputSchema: { type: "object" },
      });
      await mod.recordSwarmStructuredOutput(
        { runId, childSessionKey },
        { invalidAttempts: 0, structured: { answer: 42 } },
      );
      getLifecycleHandler()({
        runId,
        stream: "lifecycle",
        data: { phase: "end", ...terminal },
      });
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      await settleRootWork();
    }
    const entry = findRequesterRun(runId);
    expect(entry?.execution.status).toBe("terminal");
    expect(entry?.collectorCompletion?.status).toBe("done");
    expect(entry?.pauseReason).toBeUndefined();
    expect(entry?.collectorCompletion?.structured).toEqual({ answer: 42 });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });
}

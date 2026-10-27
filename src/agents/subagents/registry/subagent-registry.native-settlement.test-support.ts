import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import type { createReplyOperation } from "../../../sessions/session-controller.operation.js";
import { AGENT_RUN_TERMINAL_RETRY_GRACE_MS } from "../../agent-run-terminal-outcome.js";
import {
  createSessionEntry,
  waitForFast,
  type SubagentRegistryHarness,
} from "../../subagent-test-fixtures.test-helpers.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { saveSubagentRegistryChangesToSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type RegistryTestContext<K extends keyof ReturnType<typeof createSubagentRegistryMockState>> = {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<ReturnType<typeof createSubagentRegistryMockState>, K>;
};
type RequesterLookup = {
  findRequesterRun: (runId: string) => SubagentRunRecord | undefined;
};

export function registerQueuedCollectorLaunchSettlementTest({
  getRegistry,
  mocks,
}: RegistryTestContext<"entries">): void {
  it("keeps an in-flight queued collector pending until launch cleanup settles", async () => {
    const mod = getRegistry();
    const runId = "run-collector-launch-kill";
    const childSessionKey = "agent:main:subagent:launch-kill";
    const identity = {
      sessionId: "session-launch-kill",
      lifecycleRevision: "revision-launch-kill",
    };
    mocks.entries[childSessionKey] = createSessionEntry(identity);
    await mod.addSubagentRunForTests({
      runId,
      childSessionKey,
      childSessionIdentity: identity,
      collect: true,
      swarmRunId: runId,
      schedulerSlotId: runId,
      swarmLaunchPending: true,
      execution: { status: "queued" },
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

export function registerRestartDrainCompletionSettlementTest({
  getRegistry,
  mocks,
  findRequesterRun,
}: RegistryTestContext<"runSubagentAnnounceFlow"> & RequesterLookup): void {
  it("retries a terminal completion deferred by restart drain", async () => {
    const mod = getRegistry();
    const now = Date.now();
    const runId = "run-terminal-restart-retry";
    await mod.addSubagentRunForTests({
      runId,
      childSessionKey: "agent:main:subagent:terminal-restart-retry",
      childSessionIdentity: {
        sessionId: "session-terminal-restart-retry",
        lifecycleRevision: "revision-terminal-restart-retry",
      },
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
    expect(findRequesterRun(runId)?.cleanupCompletedAt).toBeTypeOf("number");
  });
}

export function registerForcedCollectorCompletionSettlementTests({
  getRegistry,
  mocks,
  findRequesterRun,
  getLifecycleHandler,
  mockPendingAgentWait,
}: RegistryTestContext<"entries" | "runSubagentAnnounceFlow"> &
  RequesterLookup & {
    getLifecycleHandler: () => (
      event: Pick<AgentEventPayload, "runId" | "stream" | "data">,
    ) => void;
    mockPendingAgentWait: () => void;
  }): void {
  it("settles forced collector yield through lifecycle with captured structured output", async () => {
    const mod = getRegistry();
    const runId = "forced-collector-yield";
    const childSessionKey = "agent:main:subagent:forced-collector-yield";
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
        data: {
          phase: "end",
          status: "ok",
          startedAt: 111,
          endedAt: 222,
          yielded: true,
          livenessState: "paused",
        },
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

export function registerTimeoutSuccessAnnouncementTest({
  getRegistry,
  mocks,
  findRequesterRun,
  mockPendingAgentWait,
  holdChildExecution,
  getLifecycleHandler,
  settleLifecycle,
}: RegistryTestContext<"persistRegistryRows" | "runSubagentAnnounceFlow"> &
  RequesterLookup & {
    mockPendingAgentWait: () => void;
    holdChildExecution: (
      runId: string,
      sessionKey: string,
      sessionId: string,
    ) => { operation: ReturnType<typeof createReplyOperation>; releaseExecution: () => void };
    getLifecycleHandler: () => (
      event: Pick<AgentEventPayload, "runId" | "stream" | "data">,
    ) => void;
    settleLifecycle: (event: Pick<AgentEventPayload, "runId" | "stream" | "data">) => Promise<void>;
  }): void {
  it("suppresses stale timeout announces when the same child run later finishes successfully", async () => {
    const mod = getRegistry();
    mockPendingAgentWait();
    mocks.persistRegistryRows.mockImplementation(saveSubagentRegistryChangesToSqlite);
    const { subagentRuns } = await import("./subagent-registry-memory.js");
    const { prepareSubagentRunsSnapshotForRunIds } = await vi.importActual<
      typeof import("./subagent-registry-state.js")
    >("./subagent-registry-state.js");

    const { operation, releaseExecution } = holdChildExecution(
      "run-timeout-then-ok",
      "agent:main:subagent:child",
      "sess-child",
    );
    const settleRootWork = observeRootWork();
    try {
      await mod.registerSubagentRun({
        runId: "run-timeout-then-ok",
        expectsCompletionMessage: true,
      });

      const lifecycleHandler = getLifecycleHandler();

      await settleLifecycle({
        runId: "run-timeout-then-ok",
        stream: "lifecycle",
        data: { phase: "end", endedAt: 1_000, aborted: true },
      });
      await vi.advanceTimersByTimeAsync(AGENT_RUN_TERMINAL_RETRY_GRACE_MS);
      await waitForFast(() =>
        expect(findRequesterRun("run-timeout-then-ok")?.killReconciliation).toBeDefined(),
      );

      expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

      lifecycleHandler?.({
        runId: "run-timeout-then-ok",
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: 1_250,
          terminalReply: { disposition: "visible", text: "Finished successfully." },
        },
      });
      await waitForFast(() => {
        expect(findRequesterRun("run-timeout-then-ok")?.execution.outcome).toMatchObject({
          status: "ok",
          endedAt: 1_250,
        });
      });
      const prepared = await prepareSubagentRunsSnapshotForRunIds(subagentRuns, [
        "run-timeout-then-ok",
      ]);
      expect(prepared.consume((rows) => rows.get("run-timeout-then-ok"))).toMatchObject({
        ready: true,
        value: {
          execution: { outcome: { status: "ok", endedAt: 1_250 } },
          completion: {
            terminalReply: { disposition: "visible", text: "Finished successfully." },
          },
        },
      });

      operation.complete();
      releaseExecution();
      await operation.ownerSettlement;
      await waitForFast(() => {
        expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      });
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledWith(
        expect.objectContaining({
          childRunId: "run-timeout-then-ok",
          outcome: expect.objectContaining({ status: "ok", endedAt: 1_250 }),
        }),
      );

      await mod.testing.sweepOnceForTests();
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    } finally {
      releaseExecution();
      operation.complete();
      await operation.ownerSettlement;
      await settleRootWork();
    }
  });
}

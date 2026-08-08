import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createSubagentRegistrySweeper } from "./subagent-registry-sweeper.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { createSubagentRunRecord } from "./subagent-test-fixtures.test-helpers.js";

const recoverRow = vi.hoisted(() => vi.fn());
const getAgentRunContext = vi.hoisted(() => vi.fn<(_runId: string) => unknown>(() => undefined));
const detachedTaskRuntime = vi.hoisted(() => ({
  finalizeTaskRunByRunId: vi.fn(() => [] as unknown[]),
  findDetachedTaskRun: vi.fn(() => undefined as unknown),
}));

vi.mock("./subagent-registry-restart-recovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-registry-restart-recovery.js")>();
  return { ...actual, recoverInterruptedSubagentRow: recoverRow };
});
vi.mock("../infra/agent-events.js", () => ({
  isAgentEventLifecycleGenerationCurrent: () => true,
}));
vi.mock("../infra/agent-run-registry.js", () => ({ getAgentRunContext }));
vi.mock("../tasks/detached-task-runtime.js", () => detachedTaskRuntime);

function createHarness(runtime: { current?: GatewayRecoveryRuntime }) {
  const entry = createSubagentRunRecord({
    runId: "yielded-run",
    childSessionKey: "agent:main:subagent:yielded",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "resume a yielded requester",
    cleanup: "keep",
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 55_000,
  });
  const runs = new Map([[entry.runId, entry]]);
  const resumedRuns = new Set<string>();
  const resumeRequesterSettleWake = vi.fn();
  const startSubagentAnnounceCleanupFlow = vi.fn(() => true);
  const sweeper = createSubagentRegistrySweeper({
    runs,
    resumedRuns,
    persist: vi.fn(),
    clearPendingLifecycleError: vi.fn(),
    clearPendingLifecycleTimeout: vi.fn(),
    sweepPendingLifecycle: vi.fn(),
    completeSubagentRunWithRecovery: vi.fn(),
    getGatewayRecoveryRuntime: () => runtime.current,
    abandonSubagentRestartRecoveryLaunch: vi.fn(() => true),
    clearAcceptedSubagentRestartRecovery: vi.fn(() => true),
    resumeSettledSubagentRestartRecovery: vi.fn(() => true),
    replaceSubagentRunAfterSteer: vi.fn(() => true),
    markSubagentRestartRecoveryLaunchAttempted: vi.fn((params) => ({
      sessionId: "session-id",
      sessionMarker: params.sessionMarker,
      idempotencyKey: params.idempotencyKey,
      lifecycleGeneration: params.lifecycleGeneration,
      phase: "attempted" as const,
    })),
    markSubagentRestartRecoveryLaunchAccepted: vi.fn((params) => ({
      sessionId: "session-id",
      sessionMarker: params.sessionMarker,
      idempotencyKey: params.idempotencyKey,
      phase: "accepted" as const,
    })),
    markSubagentRestartRecoveryLaunchConsumed: vi.fn((params) => ({
      sessionId: "session-id",
      sessionMarker: params.sessionMarker,
      idempotencyKey: params.idempotencyKey,
      phase: "consumed" as const,
    })),
    reserveSubagentRestartRecoveryLaunch: vi.fn(
      (params: { idempotencyKey: string }) => params.idempotencyKey,
    ),
    resetSubagentRestartRecoveryLaunchAttempt: vi.fn(() => true),
    finalizeInterruptedSubagentRun: vi.fn(async () => 0),
    resumeRequesterSettleWake,
    startSubagentAnnounceCleanupFlow,
    completeCleanupBookkeeping: vi.fn(),
    shouldEmitEndedHookForRun: vi.fn(() => false),
    emitSubagentEndedHookForRun: vi.fn(),
    callGateway: vi.fn(),
    cleanupCollectorLaunchResources: vi.fn(async () => true),
    runContextEngineSubagentEnded: vi.fn(),
    notifyContextEngineSubagentEnded: vi.fn(),
    retireSupersededRun: vi.fn(),
    getRunsForChildSession: () => [],
    getRunsForCollectorGroup: () => [],
    warn: vi.fn(),
  });
  return {
    entry,
    resumedRuns,
    resumeRequesterSettleWake,
    startSubagentAnnounceCleanupFlow,
    sweeper,
  };
}

describe("subagent registry yielded requester recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetGatewayWorkAdmission();
    recoverRow.mockReset();
    getAgentRunContext.mockReset().mockReturnValue(undefined);
    detachedTaskRuntime.finalizeTaskRunByRunId.mockReset().mockReturnValue([]);
    detachedTaskRuntime.findDetachedTaskRun.mockReset().mockReturnValue(undefined);
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    vi.useRealTimers();
  });

  it("recovers an active yielded child before admitting its frozen requester wake", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    recoverRow.mockResolvedValue({ status: "handled" });
    const { entry, resumeRequesterSettleWake, sweeper } = createHarness(runtime);
    entry.requesterSettleWake = {
      status: "pending",
      attemptCount: 0,
      batchRunIds: [entry.runId],
      requesterYieldBatch: true,
      rearmGeneration: 1,
    };

    await sweeper.sweepOnce();

    expect(resumeRequesterSettleWake).not.toHaveBeenCalled();
    expect(recoverRow).toHaveBeenCalledOnce();
    expect(entry.requesterSettleWake?.rearmGeneration).toBe(1);
    sweeper.reset();
  });

  it("leaves an interrupted yielded terminal to its recovery owner before admitting its wake", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    recoverRow.mockResolvedValue({ status: "handled" });
    const { entry, resumeRequesterSettleWake, sweeper } = createHarness(runtime);
    entry.execution = { ...entry.execution, status: "terminal", endedAt: Date.now() };
    entry.terminalOwner = "interrupted-recovery";
    entry.delivery = { status: "pending" };
    entry.requesterSettleWake = {
      status: "pending",
      attemptCount: 0,
      batchRunIds: [entry.runId],
      requesterYieldBatch: true,
      rearmGeneration: 1,
    };

    await sweeper.sweepOnce();

    expect(resumeRequesterSettleWake).not.toHaveBeenCalled();
    expect(recoverRow).toHaveBeenCalledOnce();
    sweeper.reset();
  });

  it.each([
    { name: "pending delivery", delivery: { status: "pending" as const } },
    { name: "in-progress delivery", delivery: { status: "in_progress" as const } },
    {
      name: "retryable failed delivery",
      delivery: { status: "failed" as const, disposition: "retryable" as const },
    },
    {
      name: "delivered visible final awaiting cleanup",
      delivery: { status: "delivered" as const, requesterVisibleFinalGeneration: 1 },
    },
    {
      name: "delivered visible final with a stale retry deadline",
      delivery: {
        status: "delivered" as const,
        requesterVisibleFinalGeneration: 1,
        nextAttemptAt: Number.MAX_SAFE_INTEGER,
      },
    },
    {
      name: "already announced completion with a stale retry deadline",
      delivery: {
        status: "pending" as const,
        announcedAt: 4_000,
        nextAttemptAt: Number.MAX_SAFE_INTEGER,
      },
    },
    {
      name: "failed child with a succeeded redelivery task",
      delivery: { status: "pending" as const },
      outcome: { status: "error", error: "child failed" } as const,
    },
    {
      name: "failed child with its original failed task",
      delivery: { status: "pending" as const },
      outcome: { status: "error", error: "child failed" } as const,
      taskStatus: "failed" as const,
    },
    {
      name: "timed-out child with a succeeded redelivery task",
      delivery: { status: "pending" as const },
      outcome: { status: "timeout" } as const,
    },
    {
      name: "timed-out child with its original timed-out task",
      delivery: { status: "pending" as const },
      outcome: { status: "timeout" } as const,
      taskStatus: "timed_out" as const,
    },
    {
      name: "cancelled child after its kill owner has retired",
      delivery: { status: "pending" as const },
      outcome: { status: "error", error: "Subagent run killed." } as const,
      endedReason: "subagent-killed" as const,
      taskStatus: "cancelled" as const,
    },
    {
      name: "captured empty completion",
      delivery: { status: "pending" as const },
      resultText: null,
    },
  ])(
    "resumes the canonical cleanup owner for a restored yielded $name",
    async ({ delivery, endedReason, outcome, resultText, taskStatus }) => {
      const {
        entry,
        resumedRuns,
        resumeRequesterSettleWake,
        startSubagentAnnounceCleanupFlow,
        sweeper,
      } = createHarness({});
      entry.execution = {
        ...entry.execution,
        status: "terminal",
        endedAt: Date.now(),
        outcome: outcome ?? { status: "ok" },
      };
      entry.endedReason =
        endedReason ?? (outcome?.status === "error" ? "subagent-error" : "subagent-complete");
      if (endedReason === "subagent-killed") {
        entry.suppressCompletionDelivery = true;
      }
      entry.completion = {
        required: true,
        resultText: resultText === null ? null : "child result",
      };
      entry.delivery = delivery;
      entry.requesterSettleWake = {
        status: "pending",
        attemptCount: 0,
        batchRunIds: [entry.runId],
        requesterYieldBatch: true,
        rearmGeneration: 1,
      };
      detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({
        lookup: "available",
        task: {
          runId: entry.runId,
          runtime: "subagent",
          childSessionKey: entry.childSessionKey,
          status: taskStatus ?? "succeeded",
          createdAt: entry.createdAt,
          endedAt: entry.execution.endedAt,
        },
      });

      await sweeper.sweepOnce();

      expect(startSubagentAnnounceCleanupFlow).toHaveBeenCalledOnce();
      expect(startSubagentAnnounceCleanupFlow).toHaveBeenCalledWith(entry.runId, entry);
      expect(resumedRuns.has(entry.runId)).toBe(true);
      expect(resumeRequesterSettleWake).not.toHaveBeenCalled();
      sweeper.reset();
    },
  );

  it.each([
    {
      name: "its cancellation belongs to the paused child",
      prepare: () => {},
      recovers: true,
    },
    {
      name: "a stale delivery retry deadline survived cancellation",
      prepare: (entry: SubagentRunRecord) => {
        entry.delivery = { status: "pending", nextAttemptAt: Number.MAX_SAFE_INTEGER };
      },
      recovers: true,
    },
    {
      name: "completion delivery was not authoritatively suppressed",
      prepare: (entry: SubagentRunRecord) => {
        entry.suppressCompletionDelivery = undefined;
      },
      recovers: false,
    },
    {
      name: "the terminal owner was not a kill",
      prepare: (entry: SubagentRunRecord) => {
        entry.endedReason = "subagent-error";
      },
      recovers: false,
    },
    {
      name: "the child outcome was not an error",
      prepare: (entry: SubagentRunRecord) => {
        entry.execution = { ...entry.execution, outcome: { status: "ok" } };
      },
      recovers: false,
    },
    {
      name: "the cancelled task predates the paused child",
      prepare: (
        entry: SubagentRunRecord,
        task: { status: "cancelled" | "succeeded"; endedAt: number },
      ) => {
        task.endedAt = entry.execution.endedAt! - 1;
      },
      recovers: false,
    },
    {
      name: "the cancelled task has no finite completion instant",
      prepare: (
        _entry: SubagentRunRecord,
        task: { status: "cancelled" | "succeeded"; endedAt: number },
      ) => {
        task.endedAt = Number.POSITIVE_INFINITY;
      },
      recovers: false,
    },
    {
      name: "the paused child has no finite completion instant",
      prepare: (entry: SubagentRunRecord) => {
        entry.execution = { ...entry.execution, endedAt: Number.NEGATIVE_INFINITY };
      },
      recovers: false,
    },
    {
      name: "the task belongs to a foreign generation",
      prepare: () => {
        detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({ lookup: "available" });
      },
      recovers: false,
    },
    {
      name: "the exact-generation task was not cancelled",
      prepare: (
        _entry: SubagentRunRecord,
        task: { status: "cancelled" | "succeeded"; endedAt: number },
      ) => {
        task.status = "succeeded";
      },
      recovers: false,
    },
  ])("recovers a killed paused requester child only when $name", async ({ prepare, recovers }) => {
    const {
      entry,
      resumedRuns,
      resumeRequesterSettleWake,
      startSubagentAnnounceCleanupFlow,
      sweeper,
    } = createHarness({});
    const pausedAt = Date.now() - 1_000;
    entry.execution = {
      ...entry.execution,
      status: "terminal",
      endedAt: pausedAt,
      outcome: { status: "error", error: "Subagent run killed." },
    };
    entry.endedReason = "subagent-killed";
    entry.suppressCompletionDelivery = true;
    entry.completion = { required: true };
    entry.delivery = { status: "pending" };
    entry.requesterSettleWake = {
      status: "pending",
      attemptCount: 0,
      batchRunIds: [entry.runId],
      requesterYieldBatch: true,
      rearmGeneration: 1,
    };
    const task: {
      runId: string;
      runtime: "subagent";
      childSessionKey: string;
      status: "cancelled" | "succeeded";
      createdAt: number;
      endedAt: number;
    } = {
      runId: entry.runId,
      runtime: "subagent",
      childSessionKey: entry.childSessionKey,
      status: "cancelled",
      createdAt: entry.createdAt,
      endedAt: pausedAt + 1_000,
    };
    detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({ lookup: "available", task });
    prepare(entry, task);

    await sweeper.sweepOnce();

    expect(startSubagentAnnounceCleanupFlow).toHaveBeenCalledTimes(recovers ? 1 : 0);
    expect(resumedRuns.has(entry.runId)).toBe(recovers);
    expect(resumeRequesterSettleWake).not.toHaveBeenCalled();
    sweeper.reset();
  });

  it.each([
    {
      name: "completion capture has not finished",
      prepare: (entry: SubagentRunRecord) => {
        entry.completion = { required: true };
      },
    },
    {
      name: "the cleanup owner is active",
      prepare: (entry: SubagentRunRecord) => {
        entry.cleanupHandled = true;
      },
    },
    {
      name: "the execution context is active",
      prepare: () => {
        getAgentRunContext.mockReturnValue({});
      },
    },
    {
      name: "the retry deadline has not arrived",
      prepare: (entry: SubagentRunRecord) => {
        entry.delivery = { status: "pending", nextAttemptAt: Date.now() + 10_000 };
      },
    },
    {
      name: "the correlated delivery queue owns settlement",
      prepare: (entry: SubagentRunRecord) => {
        entry.delivery = { status: "in_progress", disposition: "session_queued" };
      },
    },
    {
      name: "a staged terminal reply has not finalized its task",
      prepare: (entry: SubagentRunRecord) => {
        entry.completion = {
          required: true,
          resultText: "premature terminal reply",
          terminalReply: { disposition: "visible", text: "premature terminal reply" },
        };
        detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({
          lookup: "available",
          task: { runId: entry.runId, status: "running" },
        });
      },
    },
    {
      name: "the exact-generation task is unavailable",
      prepare: () => {
        detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({ lookup: "unavailable" });
      },
    },
    {
      name: "the exact-generation task is missing",
      prepare: () => {
        detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({ lookup: "available" });
      },
    },
    {
      name: "the exact-generation task was only marked lost",
      prepare: (entry: SubagentRunRecord) => {
        detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({
          lookup: "available",
          task: { runId: entry.runId, status: "lost" },
        });
      },
    },
    {
      name: "the exact-generation task was cancelled",
      prepare: (entry: SubagentRunRecord) => {
        detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({
          lookup: "available",
          task: { runId: entry.runId, status: "cancelled", endedAt: entry.execution.endedAt },
        });
      },
    },
    {
      name: "a cancelled completion points at an unrelated successful task",
      prepare: (entry: SubagentRunRecord) => {
        entry.execution = {
          ...entry.execution,
          outcome: { status: "error", error: "Subagent run killed." },
        };
        entry.endedReason = "subagent-killed";
        entry.suppressCompletionDelivery = true;
      },
    },
    {
      name: "the exact-generation task contradicts a successful completion",
      prepare: (entry: SubagentRunRecord) => {
        detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({
          lookup: "available",
          task: { runId: entry.runId, status: "failed", endedAt: entry.execution.endedAt },
        });
      },
    },
    {
      name: "the exact-generation task ended at a different instant",
      prepare: (entry: SubagentRunRecord) => {
        detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({
          lookup: "available",
          task: { runId: entry.runId, status: "succeeded", endedAt: entry.execution.endedAt! + 1 },
        });
      },
    },
    {
      name: "the terminal-looking child is paused after yielding",
      prepare: (entry: SubagentRunRecord) => {
        entry.pauseReason = "sessions_yield";
      },
    },
    {
      name: "the terminal-looking child has no completion outcome",
      prepare: (entry: SubagentRunRecord) => {
        entry.execution = { ...entry.execution, outcome: undefined };
      },
    },
    {
      name: "the terminal completion has no authoritative ended reason",
      prepare: (entry: SubagentRunRecord) => {
        entry.endedReason = undefined;
      },
    },
  ])("does not compete with a yielded completion when $name", async ({ prepare }) => {
    const { entry, resumeRequesterSettleWake, startSubagentAnnounceCleanupFlow, sweeper } =
      createHarness({});
    entry.execution = {
      ...entry.execution,
      status: "terminal",
      endedAt: Date.now(),
      outcome: { status: "ok" },
    };
    entry.endedReason = "subagent-complete";
    entry.completion = { required: true, resultText: "child result" };
    entry.delivery = { status: "pending" };
    entry.requesterSettleWake = {
      status: "pending",
      attemptCount: 0,
      batchRunIds: [entry.runId],
      requesterYieldBatch: true,
      rearmGeneration: 1,
    };
    detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({
      lookup: "available",
      task: {
        runId: entry.runId,
        runtime: "subagent",
        childSessionKey: entry.childSessionKey,
        status: "succeeded",
        createdAt: entry.createdAt,
        endedAt: entry.execution.endedAt,
      },
    });
    prepare(entry);

    await sweeper.sweepOnce();

    expect(startSubagentAnnounceCleanupFlow).not.toHaveBeenCalled();
    expect(resumeRequesterSettleWake).not.toHaveBeenCalled();
    sweeper.reset();
  });

  it.each([
    { name: "suspended salvage", delivery: { status: "suspended" as const, suspendedAt: 4_000 } },
    {
      name: "terminal failed salvage",
      delivery: { status: "failed" as const, disposition: "permanent_failure" as const },
      cleanupCompletedAt: 5_000,
    },
    {
      name: "a delivered completion without a final marker",
      delivery: { status: "delivered" as const },
    },
    {
      name: "a delivered completion from an older final generation",
      delivery: { status: "delivered" as const, requesterVisibleFinalGeneration: 0 },
    },
    {
      name: "a delivered final whose cleanup already completed",
      delivery: { status: "delivered" as const, requesterVisibleFinalGeneration: 1 },
      cleanupCompletedAt: 5_000,
    },
    {
      name: "an intentionally suppressed completion whose cleanup already completed",
      delivery: { status: "not_required" as const },
      cleanupCompletedAt: 5_000,
    },
  ])(
    "preserves the legitimate requester wake for $name",
    async ({ delivery, cleanupCompletedAt }) => {
      const { entry, resumeRequesterSettleWake, startSubagentAnnounceCleanupFlow, sweeper } =
        createHarness({});
      entry.execution = {
        ...entry.execution,
        status: "terminal",
        endedAt: Date.now(),
        outcome: { status: "ok" },
      };
      entry.endedReason = "subagent-complete";
      entry.completion = { required: true, resultText: "child result" };
      entry.delivery = delivery;
      entry.cleanupCompletedAt = cleanupCompletedAt;
      entry.requesterSettleWake = {
        status: "pending",
        attemptCount: 0,
        batchRunIds: [entry.runId],
        requesterYieldBatch: true,
        rearmGeneration: 1,
      };

      await sweeper.sweepOnce();

      expect(resumeRequesterSettleWake).toHaveBeenCalledOnce();
      expect(startSubagentAnnounceCleanupFlow).not.toHaveBeenCalled();
      sweeper.reset();
    },
  );
});

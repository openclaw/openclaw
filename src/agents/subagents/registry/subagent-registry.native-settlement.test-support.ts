import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import type { createReplyOperation } from "../../../sessions/session-controller.operation.js";
import {
  AGENT_RUN_TERMINAL_RETRY_GRACE_MS,
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
} from "../../agent-run-terminal-outcome.js";
import {
  createSessionEntry,
  waitForFast,
  type SubagentRegistryHarness,
} from "../../subagent-test-fixtures.test-helpers.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
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

export function registerForcedCollectorCompletionSettlementTests({
  getRegistry,
  mocks,
  findRequesterRun,
  getLifecycleHandler,
  mockPendingAgentWait,
}: RegistryTestContext<"entries" | "callGateway" | "runSubagentAnnounceFlow"> &
  RequesterLookup & {
    getLifecycleHandler: () => (
      event: Pick<AgentEventPayload, "runId" | "stream" | "data">,
    ) => void;
    mockPendingAgentWait: () => void;
  }): void {
  it("settles forced collector yield through lifecycle with captured structured output", async () => {
    vi.setSystemTime(111);
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

  it.each([
    { observation: "lifecycle", kind: "outer-timeout" },
    { observation: "wait", kind: "blocked" },
  ])(
    "preserves $kind alongside forced collector yield through $observation",
    async ({ observation, kind }) => {
      vi.setSystemTime(111);
      const mod = getRegistry();
      const runId = `forced-yield-${observation}-${kind}`;
      const childSessionKey = `agent:main:subagent:${runId}`;
      const terminal = {
        startedAt: 111,
        endedAt: 222,
        yielded: true,
        ...(kind === "blocked"
          ? { status: "error", livenessState: "blocked", error: "blocked execution" }
          : { status: "ok", aborted: true, stopReason: "timeout", livenessState: "paused" }),
      };
      const waitResult = createDeferred<Record<string, unknown>>();
      if (observation === "wait") {
        mocks.callGateway.mockImplementation(async () => waitResult.promise);
      } else {
        mockPendingAgentWait();
      }
      mocks.entries = {
        [childSessionKey]: createSessionEntry({ lifecycleRevision: "forced-timeout" }),
      };
      const settleRootWork = observeRootWork();
      await mod.registerSubagentRun({
        runId,
        childSessionKey,
        collect: true,
        expectsCompletionMessage: false,
        swarmRequesterSessionKey: "agent:main:main",
      });
      if (observation === "wait") {
        // The Gateway agent-job owner normalizes lifecycle facts before exposing
        // agent.wait. Its response is not the raw lifecycle event.
        const normalized = buildAgentRunTerminalOutcomeFromLifecycleEvent({
          phase: "end",
          data: terminal,
        });
        waitResult.resolve({ ...terminal, status: normalized.status });
      } else {
        getLifecycleHandler()({
          runId,
          stream: "lifecycle",
          data: { phase: "end", ...terminal },
        });
      }
      await vi.advanceTimersByTimeAsync(20_000);
      await settleRootWork();
      const entry = findRequesterRun(runId);
      expect(entry?.execution.outcome?.status).toBe(kind === "blocked" ? "error" : "timeout");
      expect(entry?.collectorCompletion?.status).toBe(kind === "blocked" ? "failed" : "timeout");
      expect(entry?.pauseReason).toBeUndefined();
      expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    },
  );
}

export function registerPendingAbortSettlementTests({
  getRegistry,
  mocks,
  findRequesterRun,
  getLifecycleHandler,
  mockAgentWait,
  mockPendingAgentWait,
  holdChildExecution,
}: RegistryTestContext<"entries" | "runSubagentAnnounceFlow"> &
  RequesterLookup & {
    getLifecycleHandler: () => (
      event: Pick<AgentEventPayload, "runId" | "stream" | "data">,
    ) => void;
    mockAgentWait: (response: Promise<Record<string, unknown>>) => void;
    mockPendingAgentWait: () => void;
    holdChildExecution: (
      runId: string,
      sessionKey: string,
      sessionId: string,
    ) => { operation: ReturnType<typeof createReplyOperation>; releaseExecution: () => void };
  }): void {
  it.each(["lifecycle yield", "wait yield", "explicit kill"] as const)(
    "reconciles a pending abort after %s while execution settles (#92448)",
    async (source) => {
      vi.setSystemTime(111);
      const mod = getRegistry();
      const runId = "run-after-pending-timeout";
      const waitResult = createDeferred<Record<string, unknown>>();
      if (source === "wait yield") {
        mockAgentWait(waitResult.promise);
      } else {
        mockPendingAgentWait();
      }
      const sessionEntry = createSessionEntry({
        sessionId: "sess-pending-timeout",
        lifecycleRevision: "revision-pending-timeout",
      });
      mocks.entries["agent:main:subagent:pending-timeout"] = sessionEntry;
      const { operation, releaseExecution } = holdChildExecution(
        runId,
        "agent:main:subagent:pending-timeout",
        "sess-pending-timeout",
      );
      const settleRootWork = observeRootWork();
      try {
        await mod.registerSubagentRun({
          runId,
          childSessionKey: "agent:main:subagent:pending-timeout",
          sessionEntry,
        });
        const lifecycleHandler = getLifecycleHandler();
        lifecycleHandler({
          runId,
          stream: "lifecycle",
          data: { phase: "end", startedAt: 111, endedAt: 222, aborted: true },
        });
        if (source === "explicit kill") {
          expect(await mod.markSubagentRunTerminated({ runId, reason: "manual kill" })).toBe(1);
        } else {
          if (source === "wait yield") {
            waitResult.resolve({ status: "ok", startedAt: 111, endedAt: 333, yielded: true });
          } else {
            lifecycleHandler({
              runId,
              stream: "lifecycle",
              data: { phase: "end", startedAt: 111, endedAt: 333, yielded: true, aborted: true },
            });
          }
          await waitForFast(() =>
            expect(findRequesterRun(runId)?.pauseReason).toBe("sessions_yield"),
          );
        }
        await vi.advanceTimersByTimeAsync(60_000);
        const run = findRequesterRun(runId);
        if (source === "explicit kill") {
          expect(run).toMatchObject({
            endedReason: SUBAGENT_ENDED_REASON_KILLED,
            execution: { outcome: { status: "error", error: "manual kill" } },
          });
        } else {
          expect(run?.pauseReason).toBe("sessions_yield");
        }
        expect(run?.execution.outcome?.status).not.toBe(
          source === "lifecycle yield" ? "error" : "timeout",
        );
        expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
      } finally {
        waitResult.resolve({ status: "pending" });
        releaseExecution();
        operation.complete();
        await operation.ownerSettlement;
        await settleRootWork();
      }
    },
  );
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

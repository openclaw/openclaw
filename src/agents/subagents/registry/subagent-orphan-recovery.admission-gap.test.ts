import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import { persistGatewaySessionLifecycleEvent } from "../../../gateway/session-lifecycle-state.js";
import {
  getAgentEventLifecycleGeneration,
  onAgentEvent,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { findTaskByRunId } from "../../../tasks/task-registry.js";
import { buildAgentRunTerminalOutcome } from "../../agent-run-terminal-outcome.js";
import { createAgentCommandLifecycle } from "../../command/lifecycle.js";
import type { captureSubagentCompletionReply } from "../announce/subagent-announce-output.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { RestartRecoveryParams } from "./subagent-registry-restart-recovery-types.js";
import {
  createSubagentRegistryTestDeps,
  settleSubagentRegistryPersistenceWork,
} from "./subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import {
  registerSubagentRun,
  testing,
  resetSubagentRegistryForTests,
  initSubagentRegistry,
} from "./subagent-registry.test-helpers.js";
import { useSubagentRestartRecoveryFixture } from "./subagent-restart-recovery.test-support.js";

const recoveryGate = vi.hoisted(() => ({
  beforeEntry: undefined as ((params: RestartRecoveryParams) => Promise<void>) | undefined,
}));

// Delay the real lazy-loaded helper, without replacing sweeper admission or recovery policy.
vi.mock("./subagent-registry-restart-recovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-registry-restart-recovery.js")>();
  return {
    ...actual,
    recoverInterruptedSubagentRow: async (params: RestartRecoveryParams) => {
      await recoveryGate.beforeEntry?.(params);
      return actual.recoverInterruptedSubagentRow(params);
    },
  };
});

vi.mock("../../../gateway/session-utils.fs.js", () => ({
  readSessionMessagesAsync: vi.fn(async () => []),
}));

describe("restart recovery admission while provider timeout settles", () => {
  const fixture = useSubagentRestartRecoveryFixture();

  it.each([
    ["capture pending", "timeout"],
    ["session projected", "timeout"],
    ["capture pending", "success"],
    ["terminal observed", "cancel"],
  ] as const)("preserves %s ordering for real terminal %s", async (ordering, terminalKind) => {
    console.log("ADMISSION_GAP_START", ordering);
    const runId = "admission-gap-child";
    const childSessionKey = "agent:main:subagent:admission-gap-child";
    const sessionId = "admission-gap-session";
    const startedAt = Date.now();
    const waitResult = {
      status: terminalKind === "success" ? ("ok" as const) : ("error" as const),
      stopReason:
        terminalKind === "cancel" ? "aborted" : terminalKind === "timeout" ? "restart" : "end_turn",
      timeoutPhase: terminalKind === "timeout" ? ("provider" as const) : undefined,
      startedAt,
      endedAt: startedAt + 1,
    };
    const expectedOutcome =
      terminalKind === "success" ? "ok" : terminalKind === "cancel" ? "error" : "timeout";
    const expectedSession =
      terminalKind === "success" ? "done" : terminalKind === "cancel" ? "killed" : "timeout";
    const expectedTask =
      terminalKind === "success"
        ? "succeeded"
        : terminalKind === "cancel"
          ? "cancelled"
          : "timed_out";
    const providerWait = createDeferred<typeof waitResult>();
    const waitEntered = createDeferred();
    const releaseAgentRoot = createDeferred();
    const recoveryEntered = createDeferred<RestartRecoveryParams>();
    const releaseRecovery = createDeferred();
    const captureEntered = createDeferred();
    const releaseCapture = createDeferred();
    const projections: Promise<void>[] = [];
    const observations: unknown[] = [];
    const storePath = resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
      agentId: "main",
    });
    const readSession = () => loadSessionEntry({ storePath, sessionKey: childSessionKey });
    const observe = (stage: string) => {
      console.log("ADMISSION_GAP_STAGE", ordering, stage);
      observations.push({
        stage,
        runId,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        row: structuredClone(subagentRuns.get(runId)),
        session: readSession(),
        task: findTaskByRunId(runId),
      });
    };

    // Persisted starting history has the exact shape written by settleAcceptedRecoverySession.
    // Only accepted-attempt history is seeded. The restart lifecycle must produce its abort marker.
    await replaceSessionEntry(
      { storePath, sessionKey: childSessionKey },
      {
        sessionId,
        updatedAt: startedAt,
        startedAt,
        lifecycleRunId: runId,
        status: "running",
        subagentRecovery: {
          automaticAttempts: 2,
          lastAttemptAt: startedAt - 1,
          lastRunId: "previous-accepted-recovery",
        },
      },
    );
    expect(readSession()?.abortedLastRun).toBeUndefined();
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === runId && event.stream === "lifecycle") {
        projections.push(
          persistGatewaySessionLifecycleEvent({ sessionKey: childSessionKey, event }),
        );
      }
    });
    const originalWait = fixture.gatewayRuntime.waitForAgent;
    fixture.gatewayRuntime.waitForAgent = async <T>(
      params: Parameters<GatewayRecoveryRuntime["waitForAgent"]>[0],
    ): Promise<T> => {
      if (params.runId !== runId) {
        return { status: "pending" } as T;
      }
      waitEntered.resolve();
      return (await providerWait.promise) as T;
    };
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      onAgentEvent,
      runSubagentAnnounceFlow: vi.fn(async () => "delivered" as const),
      captureSubagentCompletionReply: async (
        ...args: Parameters<typeof captureSubagentCompletionReply>
      ) => {
        captureEntered.resolve();
        if (ordering === "capture pending") {
          await releaseCapture.promise;
        }
        return (
          await import("../announce/subagent-announce-output.js")
        ).captureSubagentCompletionReply(...args);
      },
    });
    recoveryGate.beforeEntry = async (params) => {
      recoveryEntered.resolve(params);
      await releaseRecovery.promise;
    };
    resetGatewayWorkAdmission();
    let sweep: Promise<void> | undefined;
    let agentRoot: Promise<void> | undefined;
    try {
      agentRoot = runWithGatewayIndependentRootWorkAdmission(async () => {
        registerSubagentRun({
          runId,
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "continue after restart",
          cleanup: "keep",
          expectsCompletionMessage: false,
        });
        await releaseAgentRoot.promise;
      }, "test:admission-gap-agent");
      await waitEntered.promise;
      const originalRow = subagentRuns.get(runId);
      expect(getAgentRunContext(runId)).toBeUndefined();
      sweep = testing.runSweeperTickForTests();
      const admitted = await recoveryEntered.promise;
      expect(admitted.entry).toBe(originalRow);
      expect(admitted.isCurrent(runId, admitted.entry)).toBe(true);
      expect(admitted.entry.execution.endedAt).toBeUndefined();
      observe("sweeper admitted before restart and helper");
      markGatewayRestartDraining();
      createAgentCommandLifecycle({
        runId,
        startedAt,
        lifecycleGeneration: getAgentEventLifecycleGeneration,
        state: {
          currentTurnUserMessagePersisted: true,
          lifecycleEnded: false,
          lifecycleFinishing: false,
        },
      }).emitEnd({
        outcome: buildAgentRunTerminalOutcome({
          status: "error",
          stopReason: "restart",
          startedAt,
        }),
        metadata: { aborted: true },
      });
      await Promise.all(projections);
      await vi.waitFor(() => expect(subagentRuns.get(runId)?.execution.status).toBe("interrupted"));
      expect(readSession()).toMatchObject({
        status: "running",
        abortedLastRun: true,
        subagentRecovery: { automaticAttempts: 2 },
      });
      expect(getAgentRunContext(runId)).toBeUndefined();
      observe("restart projected");

      waitResult.endedAt = Date.now();
      providerWait.resolve(waitResult);
      if (terminalKind === "cancel") {
        await vi.waitFor(() => expect(originalRow?.execution.status).toBe("terminal"));
      } else {
        await captureEntered.promise;
      }
      if (ordering === "session projected") {
        await vi.waitFor(() => expect(readSession()?.status).toBe("timeout"));
      }
      expect(subagentRuns.get(runId)).toBe(originalRow);
      expect(originalRow?.execution).toMatchObject({
        status: "terminal",
        endedAt: waitResult.endedAt,
        outcome: { status: expectedOutcome },
      });
      expect(originalRow?.terminalOwner).toBeUndefined();
      observe("provider timeout before helper");
      releaseRecovery.resolve();
      await sweep;
      observe("recovery returned before capture release");
      releaseCapture.resolve();
      await vi.waitFor(() =>
        expect(subagentRuns.get(runId)?.completion?.capturedAt).toBeTypeOf("number"),
      );
      releaseAgentRoot.resolve();
      await agentRoot;
      await settleSubagentRegistryPersistenceWork();
      observe("all owners settled");
      console.log(
        "ADMISSION_GAP_OBSERVATIONS",
        JSON.stringify({ ordering, terminalKind, observations }),
      );
      expect(fixture.dispatchAgent).not.toHaveBeenCalled();
      expect(subagentRuns.get(runId)).toBe(originalRow);
      expect(originalRow?.execution).toMatchObject({
        status: "terminal",
        endedAt: waitResult.endedAt,
        outcome: { status: expectedOutcome },
      });
      expect(loadSubagentRegistryFromSqlite().get(runId)?.execution).toMatchObject({
        status: "terminal",
        endedAt: waitResult.endedAt,
        outcome: { status: expectedOutcome },
      });
      expect(findTaskByRunId(runId)?.status).toBe(expectedTask);
      expect(readSession()?.status).toBe(expectedSession);
      if (ordering === "session projected") {
        // A real timeout also remains terminal after SQLite hydration and lifecycle rotation.
        recoveryGate.beforeEntry = async () => {
          throw new Error("cold terminal entered recovery");
        };
        resetSubagentRegistryForTests({ persist: false });
        resetGatewayWorkAdmission();
        rotateAgentEventLifecycleGeneration();
        initSubagentRegistry();
        fixture.activateGatewayRuntime();
        await testing.sweepOnceForTests();
        expect(subagentRuns.get(runId)?.execution).toMatchObject({
          status: "terminal",
          outcome: { status: "timeout" },
        });
        expect(subagentRuns.get(runId)?.terminalOwner).toBeUndefined();
        expect(fixture.dispatchAgent).not.toHaveBeenCalled();
      }
    } finally {
      releaseRecovery.resolve();
      releaseCapture.resolve();
      providerWait.resolve(waitResult);
      releaseAgentRoot.resolve();
      await agentRoot;
      await sweep;
      await settleSubagentRegistryPersistenceWork();
      recoveryGate.beforeEntry = undefined;
      unsubscribe();
      fixture.gatewayRuntime.waitForAgent = originalWait;
      resetGatewayWorkAdmission();
    }
  });
});

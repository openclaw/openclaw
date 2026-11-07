import { afterEach, beforeEach, assert, expect, it, vi } from "vitest";
import {
  bindGoalContinuationExecution,
  createGoalContinuationReturnScope,
  finishGoalContinuationSettlement,
  promoteGoalContinuationYield,
  revokeGoalContinuationReturn,
  withGoalContinuationSettlement,
} from "../auto-reply/reply/goal-continuation-return.js";
import { refreshActiveGoalContext } from "../auto-reply/reply/inbound-meta.js";
import type { FollowupRun } from "../auto-reply/reply/queue/types.js";
import {
  readAgentRunTerminalError,
  readAgentRunTerminalOutcome,
} from "../channels/turn/agent-run-terminal-outcome.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import {
  agentCommandFromGatewayIngress,
  compactionTestRuntime,
  compactionTestState as state,
  GATEWAY_INGRESS_ARGS,
  makeCompactionResult,
  registerAgentCommandCompactionTestHooks,
  requireCompactionStorePath,
} from "./agent-command.compaction.test-support.js";
import * as attemptCallbacks from "./command/attempt-callbacks.js";
import type { RunEmbeddedAgentInternalParams } from "./embedded-agent-runner/run/internal-params.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import type { SubagentRunRecord } from "./subagents/registry/subagent-registry.types.js";

const runEmbeddedAgent = vi.hoisted(() => vi.fn());
// mock-isolation: Keep provider execution outside the real command admission and settlement fixture.
vi.mock("./embedded-agent.js", () => ({ runEmbeddedAgent }));

registerAgentCommandCompactionTestHooks();
beforeEach(() => {
  assert.isDefined(state.cfg);
  setRuntimeConfigSnapshot(state.cfg);
});

const retainedChildren = new Set<SubagentRunRecord>();
afterEach(() => {
  clearRuntimeConfigSnapshot();
  for (const child of retainedChildren) {
    revokeGoalContinuationReturn(child);
  }
  retainedChildren.clear();
});

async function retainGoalReturn(sessionId: string, sessionKey: string, goalId: string) {
  assert.isDefined(state.agentDir);
  assert.isDefined(state.workspaceDir);
  assert.isDefined(state.cfg);
  const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
  const base: FollowupRun = {
    prompt: "Write once.",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      agentDir: state.agentDir,
      sessionId,
      sessionKey,
      sessionFile: sessionKey,
      workspaceDir: state.workspaceDir,
      config: state.cfg,
      provider: "openai",
      model: "gpt-5.5",
      timeoutMs: 10000,
      blockReplyBreak: "text_end",
    },
  };
  const child: SubagentRunRecord = {
    runId: "recovery-child",
    childSessionKey: "agent:main:subagent:recovery-child",
    childAgentId: "main",
    requesterSessionKey: sessionKey,
    requesterAgentId: "main",
    requesterDisplayKey: sessionKey,
    completionRequesterSessionId: sessionId,
    task: "Verify the write",
    cleanup: "keep",
    createdAt: 1000,
    execution: { status: "terminal", endedAt: 1100, outcome: { status: "ok" } },
    requesterSettleWake: {
      status: "dispatching",
      attemptCount: 1,
      requesterYieldBatch: true,
      rearmGeneration: 1,
      batchRunIds: ["recovery-child"],
    },
  };
  retainedChildren.add(child);
  const resume = vi.fn<Parameters<typeof createGoalContinuationReturnScope>[0]["resume"]>(
    async () => {},
  );
  try {
    createGoalContinuationReturnScope({
      base,
      sessionKey,
      storePath: requireCompactionStorePath(),
      expectedSession: { sessionId },
      initialGoalId: goalId,
      operation,
      context: (_continuation, entry, existing) => refreshActiveGoalContext(existing, entry),
      resume,
    })(() => {
      bindGoalContinuationExecution("lending-turn", sessionKey);
      promoteGoalContinuationYield({
        entries: [child],
        requesterTurnRunId: "lending-turn",
        rearmGeneration: 1,
      });
    });
  } finally {
    operation.complete();
    await operation.ownerSettlement;
  }
  return { child, resume, base };
}

it.each([
  { outcome: "recovered", harnessId: "openclaw" },
  { outcome: "recovered", harnessId: "codex" },
  { outcome: "recovered", harnessId: "claude-cli" },
  { outcome: "preparation-failure", harnessId: "codex" },
  { outcome: "later-failure", harnessId: "codex" },
] as const)(
  "selects the $harnessId terminal after $outcome without a second native start",
  async ({ outcome, harnessId }) => {
    runEmbeddedAgent.mockReset();
    const { runAgentAttempt } = await vi.importActual<
      typeof import("./command/attempt-execution.js")
    >("./command/attempt-execution.js");
    state.runAgentAttemptMock.mockImplementation(runAgentAttempt);
    assert.isDefined(state.cfg?.agents?.defaults);
    state.cfg.agents.defaults.model = { primary: "openai/gpt-5.5" };
    const sessionId = "command-recovered-session";
    const sessionKey = "agent:main:recovered-command";
    const runId = `command-${outcome}`;
    const goalId = "recovered-command-goal";
    const target = { agentId: "main", sessionKey, storePath: requireCompactionStorePath() };
    await compactionTestRuntime.replaceSessionEntry(target, {
      sessionId,
      updatedAt: Date.now(),
      modelProvider: "openai",
      model: "gpt-5.5",
      agentHarnessId: "openclaw",
      goal: {
        schemaVersion: 1,
        id: goalId,
        status: "active",
        objective: "Complete and verify the write",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tokenStart: 0,
        tokensUsed: 0,
        continuationTurns: 0,
      },
    });
    const { child, resume, base } = await retainGoalReturn(sessionId, sessionKey, goalId);
    const receipt = {
      runId,
      sessionId,
      turnId: "recovery",
      requested: { provider: "openai", model: "gpt-5.5" },
      effective: { provider: "openai", model: "gpt-5.5", responseModel: "gpt-5.5" },
      successfulToolNames: ["write"],
      assistantTranscriptIdempotencyKey: "selected-recovery",
      rerouted: false,
      terminalDisposition: "visible" as const,
    };
    const createCallbacks = attemptCallbacks.createAgentAttemptLifecycleCallbacks;
    let selectedResult: EmbeddedAgentRunResult | undefined;
    let observedState: attemptCallbacks.AgentAttemptLifecycleState | undefined;
    let observedRecorder: RunEmbeddedAgentInternalParams["userTurnTranscriptRecorder"];
    using _ = vi
      .spyOn(attemptCallbacks, "createAgentAttemptLifecycleCallbacks")
      .mockImplementation((lifecycleState, onRuntimeTurnStarted) => {
        observedState = lifecycleState;
        return createCallbacks(lifecycleState, onRuntimeTurnStarted);
      });
    runEmbeddedAgent.mockImplementationOnce(async (params: RunEmbeddedAgentInternalParams) => {
      observedRecorder = params.userTurnTranscriptRecorder;
      assert.isDefined(observedRecorder);
      observedRecorder.markRuntimePersisted({ role: "user", content: "Write once.", timestamp: 1 });
      await params.onAgentEvent?.({
        stream: "lifecycle",
        data: {
          phase: "finishing",
          error: "old capacity error",
          errorObservation: { httpStatus: 503 },
          assistantTranscriptIdempotencyKey: "superseded-attempt",
        },
      });
      expect(params.onAttemptStart).toEqual(expect.any(Function));
      expect(params.onAttemptTerminalReplaced).toEqual(expect.any(Function));
      if (outcome === "preparation-failure") {
        params.onAttemptStart?.();
        throw new Error("new attempt preparation failed");
      }
      params.onAttemptTerminalReplaced?.();
      if (outcome === "later-failure") {
        await params.onAgentEvent?.({
          stream: "lifecycle",
          data: { phase: "finishing", error: "recovery persistence failed" },
        });
      }
      const result = makeCompactionResult({
        sessionId,
        text: "The write completed.",
        runner: harnessId === "claude-cli" ? "cli" : "embedded",
        agentHarnessId: harnessId === "claude-cli" ? undefined : harnessId,
      });
      assert.isDefined(result.meta.agentMeta);
      result.meta.agentMeta.terminalReceipt = receipt;
      result.meta.terminalReply = { disposition: "visible", text: "The write completed." };
      if (outcome === "later-failure") {
        result.meta.stopReason = "error";
        result.meta.error = { kind: "incomplete_turn", message: "recovery persistence failed" };
      }
      selectedResult = result;
      return result;
    });

    const pending = withGoalContinuationSettlement(
      [child],
      runId,
      () => true,
      () =>
        agentCommandFromGatewayIngress(
          {
            sessionKey,
            sessionId,
            runId,
            message: "Write once.",
            deliver: false,
            allowModelOverride: false,
          },
          ...GATEWAY_INGRESS_ARGS,
        ),
    );
    if (outcome === "preparation-failure") {
      await expect(pending).rejects.toThrow("new attempt preparation failed");
    } else {
      const result = await pending;
      expect(readAgentRunTerminalOutcome(result)).toBe(
        outcome === "recovered" ? "completed" : "failed",
      );
      expect(readAgentRunTerminalError(result)).toBe(
        outcome === "recovered" ? undefined : "recovery persistence failed",
      );
    }
    // The actual command terminal can lend pursuit only after child-batch settlement.
    expect(resume).not.toHaveBeenCalled();
    await finishGoalContinuationSettlement([child], true);
    if (outcome === "recovered") {
      assert.isDefined(selectedResult);
      expect(resume).toHaveBeenCalledOnce();
      expect(resume.mock.calls[0]?.[0]).toMatchObject({
        continuation: { sessionId, goalId },
        base,
        runId,
        result: selectedResult,
        isCurrent: expect.any(Function),
      });
    } else {
      expect(resume).not.toHaveBeenCalled();
    }
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(observedRecorder?.hasPersisted()).toBe(true);
    expect(observedState?.lifecycleEnded).toBe(true);
    const terminals = state.emitAgentEventMock.mock.calls
      .map(([event]) => event)
      .filter(
        (event) =>
          event.runId === runId &&
          event.stream === "lifecycle" &&
          ["end", "error"].includes(event.data.phase),
      );
    expect(terminals).toHaveLength(1);
    expect(terminals[0].data).toMatchObject({
      phase: outcome === "recovered" ? "end" : "error",
      executionSettled: true,
      ...(outcome !== "preparation-failure" ? { terminalReceipt: receipt } : {}),
    });
    expect(terminals[0].data.error).toBe(
      outcome === "recovered"
        ? undefined
        : outcome === "preparation-failure"
          ? "new attempt preparation failed"
          : "recovery persistence failed",
    );
    expect(terminals[0].data).not.toHaveProperty("errorObservation");
  },
);

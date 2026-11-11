import { assert, expect, it, vi } from "vitest";
import {
  readAgentRunTerminalError,
  readAgentRunTerminalOutcome,
} from "../channels/turn/agent-run-terminal-outcome.js";
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

const runEmbeddedAgent = vi.hoisted(() => vi.fn());
// mock-isolation: Keep provider execution outside the real command admission and settlement fixture.
vi.mock("./embedded-agent.js", () => ({ runEmbeddedAgent }));

registerAgentCommandCompactionTestHooks();

it.each(["recovered", "preparation-failure", "later-failure"] as const)(
  "selects the command terminal after %s without a second native start",
  async (outcome) => {
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
    const target = { agentId: "main", sessionKey, storePath: requireCompactionStorePath() };
    await compactionTestRuntime.replaceSessionEntry(target, {
      sessionId,
      updatedAt: Date.now(),
      modelProvider: "openai",
      model: "gpt-5.5",
      agentHarnessId: "openclaw",
    });
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
        runner: "embedded",
      });
      assert.isDefined(result.meta.agentMeta);
      result.meta.agentMeta.terminalReceipt = receipt;
      result.meta.terminalReply = { disposition: "visible", text: "The write completed." };
      if (outcome === "later-failure") {
        result.meta.stopReason = "error";
        result.meta.error = { kind: "incomplete_turn", message: "recovery persistence failed" };
      }
      return result;
    });

    const pending = agentCommandFromGatewayIngress(
      {
        sessionKey,
        sessionId,
        runId,
        message: "Write once.",
        deliver: false,
        allowModelOverride: false,
      },
      ...GATEWAY_INGRESS_ARGS,
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

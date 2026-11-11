import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import { Type } from "typebox";
import { afterEach, beforeEach, expect, it, onTestFinished } from "vitest";
import {
  captureAgent,
  makeCall,
  makeAssistantMessage,
  startToolCalls,
  finishMessageStream,
  makeTool,
} from "../../../../packages/agent-core/src/agent-loop.test-support.js";
import { REPEATED_TOOL_ERROR_CODE } from "../../../../packages/agent-core/src/errors.js";
import { setInternalBeforeToolBatch } from "../../../../packages/agent-core/src/internal-hooks.js";
import type { AgentToolCall } from "../../../../packages/agent-core/src/types.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { configureExecutionDecisionWorkSink } from "../../../audit/execution-decision-work.js";
import type { ExecutionDecisionWork } from "../../../audit/execution-decision-work.types.js";
import { createExecutionIdentityAdmissionToken } from "../../../audit/execution-identity-admission.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../../../logging/diagnostic-session-state.js";
import { bindAgentToolActionDescriptor } from "../../agent-tool-metadata.js";
import { consumeBatchAdmittedToolCall } from "../../agent-tools.before-tool-call.state.js";
import type { HookContext } from "../../agent-tools.before-tool-call.types.js";
import { wrapToolWithBeforeToolCallHook } from "../../agent-tools.before-tool-call.wrapper.js";
import type { AnyAgentTool } from "../../tools/common.js";
import { withGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import {
  createToolLoopBatchAdmission,
  installToolLoopRecoveryCleanup,
} from "./tool-loop-recovery.js";

beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetDiagnosticSessionStateForTest();
});

function observeWrapper(source: AnyAgentTool, scope: HookContext) {
  const diagnostics: DiagnosticEventPayload[] = [];
  const decisions: ExecutionDecisionWork[] = [];
  onTestFinished(onInternalDiagnosticEvent((event) => diagnostics.push(event)));
  onTestFinished(
    configureExecutionDecisionWorkSink((work) => {
      decisions.push(work);
      return true;
    }),
  );
  bindAgentToolActionDescriptor(source, {
    family: "tool",
    operation: "memory",
  });
  const tool = wrapToolWithBeforeToolCallHook(source, scope);
  return {
    tool,
    diagnostics,
    decisions,
    run: (run: () => Promise<void>) =>
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: scope.sessionKey ?? "test:recovery-wrapper",
          executionIdentityToken: createExecutionIdentityAdmissionToken(
            scope.runId ?? "recovery-wrapper",
          ),
          receiptAuthority: () => true,
        },
        run,
      ),
  };
}

it.each([false, true].flatMap((quarantined) => [0, 1].map((raw) => ({ quarantined, raw }))))(
  "checks final prepared arguments through the real wrapper (raw=$raw, quarantined=$quarantined)",
  async ({ quarantined, raw }) => {
    const values: number[] = [];
    const outcomes: unknown[] = [];
    const scope = {
      sessionKey: `test:final-args:${raw}:${quarantined}`,
      runId: `final-args:${raw}:${quarantined}`,
      loopDetection: { enabled: true },
      onToolOutcome: (outcome: unknown) => outcomes.push(outcome),
    };
    const observed = observeWrapper(
      {
        ...makeTool("probe"),
        parameters: Type.Object({ value: Type.Number() }),
        resultContentSource: "network",
        prepareBeforeToolCallParams: (_params, context) => ({
          value: context?.toolCallId === "changed" && !quarantined ? 1 : 0,
        }),
        execute: async (_id, args: { value: number }) => {
          values.push(args.value);
          if (args.value === 0) {
            throw new Error("same failure");
          }
          return { content: [{ type: "text", text: "progress" }], details: {} };
        },
      },
      scope,
    );
    const turns = Array.from({ length: 4 }, (_, i) => [
      {
        ...makeCall("probe", i === 3 ? "changed" : String(i)),
        arguments: { value: i === 3 ? raw : 0 },
      },
    ]);
    const { agent, requests, events } = captureAgent([observed.tool], {}, [
      ...turns,
      ...(quarantined ? [] : [[{ type: "text" as const, text: "done" }]]),
    ]);
    setInternalBeforeToolBatch(agent, createToolLoopBatchAdmission(scope));
    installToolLoopRecoveryCleanup({ agent, runId: scope.runId });
    let reservationReleased = false;
    agent.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.errorCode === REPEATED_TOOL_ERROR_CODE
      ) {
        reservationReleased = !consumeBatchAdmittedToolCall("changed", scope.runId);
      }
    });
    await observed.run(() => agent.prompt("start"));
    await waitForDiagnosticEventsDrained();
    expect(values).toEqual(quarantined ? [0, 0, 0] : [0, 0, 0, 1]);
    expect(requests).toHaveLength(quarantined ? 4 : 5);
    expect(agent.state.messages.at(-1)).toMatchObject(
      quarantined ? { errorCode: REPEATED_TOOL_ERROR_CODE } : { stopReason: "stop" },
    );
    expect(reservationReleased).toBe(quarantined);
    expect(
      getDiagnosticSessionState(scope).toolCallHistory?.map((call) => call.toolCallId),
    ).toEqual(quarantined ? ["0", "1", "2"] : ["0", "1", "2", "changed"]);
    expect(outcomes).toHaveLength(quarantined ? 3 : 4);
    expect(
      events.find((event) => event.type === "tool_execution_end" && event.toolCallId === "changed"),
    ).toMatchObject({ executionStarted: !quarantined });
    expect(
      observed.diagnostics
        .filter((event) => "toolCallId" in event && event.toolCallId === "changed")
        .map((event) => event.type)
        .filter((type) => type.startsWith("tool.execution.")),
    ).toEqual(
      quarantined
        ? ["tool.execution.blocked"]
        : ["tool.execution.started", "tool.execution.completed"],
    );
    expect(observed.decisions.map((work) => work.receipt.decision.reasonCode)).toEqual([
      "generic_action_attributed",
      "generic_action_attributed",
      "generic_action_attributed",
      quarantined ? "generic_action_suppressed" : "generic_action_attributed",
    ]);
  },
);

it.each(["delayed preparation", "sequential tail"] as const)(
  "closes all source starts after terminal recovery: %s",
  async (kind) => {
    const admitted = createDeferred();
    const terminalObserved = createDeferred();
    const response = createAssistantMessageEventStream();
    const starts: string[] = [];
    const scope = {
      sessionKey: "test:terminal-start:" + kind,
      runId: "terminal-start:" + kind,
      loopDetection: { enabled: true },
    };
    const observed = observeWrapper(
      {
        ...makeTool("mutate"),
        ...(kind === "sequential tail" ? { executionMode: "sequential" as const } : {}),
        prepareBeforeToolCallParams: async (params) => {
          if (kind === "delayed preparation") {
            admitted.resolve();
            await terminalObserved.promise;
          }
          return params;
        },
        execute: async () => {
          starts.push("mutate");
          return { content: [], details: { committed: true } };
        },
      },
      scope,
    );
    const failing = ["a", "b"].map((name) =>
      Object.assign(makeTool(name), {
        execute: async (id: string) => {
          starts.push(id);
          if (id === "b3") {
            await admitted.promise;
          }
          throw new Error("same failure");
        },
      }),
    );
    const { agent, requests, events } = captureAgent(
      [...failing, observed.tool],
      {},
      ["a1", "a2", "a3", "b1", "b2"].map((id) => [makeCall(id.slice(0, 1), id)]),
    );
    const admission = createToolLoopBatchAdmission(scope);
    setInternalBeforeToolBatch(agent, async (context, signal) => {
      const result = await admission(context, signal);
      if (
        kind === "sequential tail" &&
        context.calls.some((call) => call.toolCall.name === "mutate")
      ) {
        admitted.resolve();
      }
      return result;
    });
    installToolLoopRecoveryCleanup({ agent, runId: scope.runId });
    const initial = agent.streamFn;
    let turn = 0;
    agent.streamFn = (...args) => {
      if (++turn < 6) {
        return initial(...args);
      }
      requests.push(args[1].messages.slice());
      return response;
    };
    agent.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "toolResult" &&
        event.message.toolCallId === "b3"
      ) {
        terminalObserved.resolve();
      }
    });
    const running = observed.run(() => agent.prompt("start"));
    onTestFinished(async () => {
      admitted.resolve();
      terminalObserved.resolve();
      response.end({ ...makeAssistantMessage([]), stopReason: "aborted" });
      await running;
    });
    const streamed: AgentToolCall[] = [{ ...makeCall("b", "b3"), async: true }, makeCall("mutate")];
    startToolCalls(response, streamed);
    finishMessageStream(response, makeAssistantMessage(streamed));
    await running;
    await waitForDiagnosticEventsDrained();
    expect(starts).toEqual(["a1", "a2", "a3", "b1", "b2", "b3"]);
    expect(requests).toHaveLength(6);
    expect(agent.state.messages.at(-1)).toMatchObject({ errorCode: REPEATED_TOOL_ERROR_CODE });
    expect(
      events.find((event) => event.type === "tool_execution_end" && event.toolCallId === "mutate"),
    ).toMatchObject({
      executionStarted: false,
      result: { details: { status: "blocked", deniedReason: "tool-loop" } },
    });
    expect(
      getDiagnosticSessionState(scope).toolCallHistory?.some(
        (call) => call.toolCallId === "mutate",
      ),
    ).toBe(false);
    expect(
      observed.diagnostics
        .filter((event) => "toolCallId" in event && event.toolCallId === "mutate")
        .map((event) => event.type)
        .filter((type) => type.startsWith("tool.execution.")),
    ).toEqual(["tool.execution.blocked"]);
    expect(observed.decisions.map((work) => work.receipt.decision.reasonCode)).toEqual([
      "generic_action_suppressed",
    ]);
  },
);

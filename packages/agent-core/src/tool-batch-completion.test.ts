import { describe, expect, it, vi } from "vitest";
import { makeAssistantMessage } from "./agent-loop.test-support.js";
import type { ExecutedToolCallBatch } from "./agent-stream-response.js";
import { commitInternalToolTurnInput } from "./internal-hooks.js";
import { combineExecutedToolBatches } from "./tool-batch-completion.js";
import type { AgentLoopConfig } from "./types.js";

describe("tool batch terminal identity", () => {
  const recovery: ExecutedToolCallBatch = {
    messages: [],
    terminalToolCallIds: [],
    steeringMessages: [],
    terminate: false,
    terminateRun: false,
    intervention: {
      kind: "critical-tool-loop",
      toolCallId: "recovery-call",
      toolName: "read",
      actionKey: "read:unchanged",
      detector: "generic_repeat",
      count: 20,
      reason: "Reassess the repeated read",
    },
  };
  const terminal: ExecutedToolCallBatch = {
    messages: [],
    terminalToolCallIds: [],
    steeringMessages: [],
    terminate: true,
    terminateRun: true,
    intervention: {
      kind: "critical-tool-loop",
      toolCallId: "failed-call",
      toolName: "probe",
      actionKey: "probe:failed",
      detector: "repeated_tool_error",
      count: 3,
      reason: "Check the tool error before retrying",
    },
  };

  it.each([false, true])(
    "retains the terminating intervention when its batch completes first=%s",
    (terminalFirst) => {
      const result = combineExecutedToolBatches(
        {},
        makeAssistantMessage([]),
        terminalFirst ? [terminal, recovery] : [recovery, terminal],
      );
      expect(result).toMatchObject({
        terminateRun: true,
        intervention: {
          detector: "repeated_tool_error",
          toolCallId: "failed-call",
          reason: "Check the tool error before retrying",
        },
      });
    },
  );

  it("keeps the recovery intervention when no batch terminates the run", () => {
    expect(combineExecutedToolBatches({}, makeAssistantMessage([]), [recovery])).toMatchObject({
      terminateRun: false,
      intervention: { detector: "generic_repeat" },
    });
  });

  it("keeps input identity until commit without consuming or duplicating queued steering", () => {
    const input = { role: "user" as const, content: "Next input", timestamp: 1 };
    const completesToolTurn = vi.fn<NonNullable<AgentLoopConfig["completesToolTurn"]>>(() => true);
    const result = combineExecutedToolBatches({ completesToolTurn }, makeAssistantMessage([]), [
      { ...recovery, steeringMessages: [input] },
      { ...terminal, steeringMessages: [input] },
    ]);
    const firstScope = completesToolTurn.mock.calls[0]?.[0].inputScope;
    combineExecutedToolBatches({ completesToolTurn }, makeAssistantMessage([]), [recovery]);
    expect(completesToolTurn.mock.calls[1]?.[0].inputScope).toBe(firstScope);
    commitInternalToolTurnInput(completesToolTurn);
    combineExecutedToolBatches({ completesToolTurn }, makeAssistantMessage([]), [recovery]);
    expect(completesToolTurn.mock.calls[2]?.[0].inputScope).not.toBe(firstScope);
    expect(result.steeringMessages).toEqual([input]);
  });
});

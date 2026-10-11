import { describe, expect, it } from "vitest";
import { makeAssistantMessage } from "./agent-loop.test-support.js";
import type { ExecutedToolCallBatch } from "./agent-stream-response.js";
import { combineExecutedToolBatches } from "./tool-batch-completion.js";

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
});

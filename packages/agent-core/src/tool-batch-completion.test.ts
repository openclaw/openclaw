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
  };
  const terminal: ExecutedToolCallBatch = {
    messages: [],
    terminalToolCallIds: [],
    steeringMessages: [],
    terminate: true,
    repeatStop: { kind: "stop", toolCallId: "repeat-call", toolName: "probe", count: 20 },
  };

  it.each([false, true])("keeps the repeat stop when its batch completes first=%s", (first) => {
    const result = combineExecutedToolBatches(
      {},
      makeAssistantMessage([]),
      first ? [terminal, recovery] : [recovery, terminal],
    );
    expect(result).toMatchObject({ repeatStop: { toolCallId: "repeat-call", count: 20 } });
  });

  it("has no repeat stop when no batch reached the cap", () => {
    expect(combineExecutedToolBatches({}, makeAssistantMessage([]), [recovery])).not.toHaveProperty(
      "repeatStop",
    );
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

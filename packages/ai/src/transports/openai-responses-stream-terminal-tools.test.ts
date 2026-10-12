import { describe, expect, it } from "vitest";
import { completed, runFixture } from "./openai-responses-stream-parity.test-helpers.js";

const tool = (slot: number, overrides: Record<string, unknown> = {}) => ({
  type: "function_call",
  id: `fc_${slot}`,
  call_id: `call_${slot}`,
  name: "lookup",
  arguments: JSON.stringify({ slot }),
  status: "completed",
  ...overrides,
});
const added = (slot: number, overrides: Record<string, unknown> = {}) => ({
  type: "response.output_item.added",
  output_index: slot,
  item: tool(slot, { arguments: "", status: "in_progress", ...overrides }),
});

describe("Responses terminal tool completion", () => {
  it("does not publish anonymous unindexed completions before ambiguous terminal matching", async () => {
    const anonymous = { id: undefined, call_id: undefined };
    const result = await runFixture([
      { ...added(0, anonymous), output_index: undefined },
      { type: "response.output_item.done", item: tool(0, anonymous) },
      { ...added(1, anonymous), output_index: undefined },
      { type: "response.output_item.done", item: tool(1, anonymous) },
      completed("resp_ambiguous_done", [tool(0), tool(1)]),
    ]);
    expect(result.error).not.toBeNull();
    expect(result.events.filter((event) => event.type === "toolcall_end")).toEqual([]);
  });

  it.each(["unindexed"])(
    "completes a %s call exactly once when its item-done event is missing",
    async (identity) => {
      const anonymous = identity === "anonymous" ? { id: undefined, call_id: undefined } : {};
      const item = tool(0, {
        ...anonymous,
        ...(identity === "rotated" ? { id: "fc_terminal_rotated" } : {}),
        arguments: '{"slot":0,"id":9007199254740993}',
      });
      const result = await runFixture([
        {
          ...added(0, anonymous),
          ...(identity === "unindexed" || identity === "anonymous"
            ? { output_index: undefined }
            : {}),
        },
        completed("resp_missing_done", [item]),
      ]);
      expect(result.error).toBeNull();
      expect(result.stopReason).toBe("toolUse");
      expect(result.events).toEqual([
        { type: "toolcall_start", contentIndex: 0 },
        { type: "toolcall_end", contentIndex: 0 },
      ]);
      expect(result.content).toEqual([
        {
          type: "toolCall",
          id:
            identity === "anonymous"
              ? "call_<generated>"
              : `call_0|${identity === "rotated" ? "fc_terminal_rotated" : "fc_0"}`,
          name: "lookup",
          arguments: { slot: 0, id: "9007199254740993" },
          partialJson: false,
        },
      ]);
    },
  );

  it.each([
    ["malformed arguments", { arguments: '{"slot":' }],
    ["incomplete status", { status: "incomplete" }],
    ["changed name", { name: "delete_record" }],
  ])(
    "rejects a terminal batch with later %s before any tool completes",
    async (_name, override) => {
      const result = await runFixture([
        added(0),
        added(1),
        completed("resp_invalid_batch", [tool(0), tool(1, override)]),
      ]);
      expect(result.error).not.toBeNull();
      expect(result.events.filter((event) => event.type === "toolcall_end")).toEqual([]);
    },
  );

  it("rejects a changed completed call identity before another active call completes", async () => {
    const result = await runFixture([
      { type: "response.output_item.done", output_index: 0, item: tool(0) },
      added(1),
      completed("resp_completed_conflict", [tool(0, { call_id: "call_conflicting" }), tool(1)]),
    ]);
    expect(result.error).toBe("Responses stream changed output item identity");
    expect(result.events.filter((event) => event.type === "toolcall_end")).toEqual([
      { type: "toolcall_end", contentIndex: 0 },
    ]);
  });

  it.each([["duplicate call", [tool(0), tool(0)]]])(
    "rejects a terminal %s without completing the active call",
    async (_name, items) => {
      const result = await runFixture([added(0), completed("resp_unresolved", items)]);
      expect(result.error).not.toBeNull();
      expect(result.events.filter((event) => event.type === "toolcall_end")).toEqual([]);
    },
  );

  it("never completes active tools from an incomplete response", async () => {
    const result = await runFixture([
      added(0),
      {
        type: "response.incomplete",
        response: { id: "resp_incomplete", status: "incomplete", output: [tool(0)] },
      },
    ]);
    expect(result.error).toBe("Responses stream completed with unresolved tool calls");
    expect(result.events.filter((event) => event.type === "toolcall_end")).toEqual([]);
  });

  it("prefers streamed arguments when both are schema-valid but different", async () => {
    const streamedArgs = JSON.stringify({ if_match: '"rev-4"', object_id: "x" });
    const doneArgs = JSON.stringify({ if_match: '"rev-1"', object_id: "x" });
    const result = await runFixture([
      added(0),
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "fc_0",
        delta: streamedArgs,
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        item_id: "fc_0",
        name: "lookup",
        arguments: streamedArgs,
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: tool(0, { arguments: doneArgs }),
      },
      completed("resp_schema_valid_disagree", [tool(0, { arguments: streamedArgs })]),
    ]);
    expect(result.error).toBeNull();
    const toolCall = result.content[0] as { arguments: unknown };
    expect(toolCall.arguments).toEqual({ if_match: '"rev-4"', object_id: "x" });
  });

  it("uses done snapshot when streamed buffer is marked unreliable", async () => {
    const doneArgs = JSON.stringify({ slot: 0 });
    const streamedArgs = JSON.stringify({ slot: 9 });
    const result = await runFixture([
      added(0),
      // Route a complete, disagreeing buffer so the preference would fire
      // without the reliability gate.
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "fc_0",
        delta: streamedArgs,
      },
      added(1),
      // A delta with no output_index and a non-matching item_id cannot route
      // to either active call, so markArgumentsUnreliable fires on both,
      // clearing the preference even though the buffer is complete JSON.
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_unknown",
        delta: streamedArgs,
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: tool(0, { arguments: doneArgs }),
      },
      completed("resp_unreliable", [tool(0, { arguments: doneArgs }), tool(1)]),
    ]);
    expect(result.error).toBeNull();
    const toolCall = result.content[0] as { arguments: unknown };
    expect(toolCall.arguments).toEqual({ slot: 0 });
  });
});

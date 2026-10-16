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
const done = (slot: number, overrides: Record<string, unknown> = {}) => ({
  type: "response.output_item.done",
  output_index: slot,
  item: tool(slot, overrides),
});
const argumentEvent = (type: string, slot: number, fields: Record<string, unknown>) => ({
  type: `response.function_call_arguments.${type}`,
  output_index: slot,
  item_id: `fc_${slot}`,
  ...fields,
});

describe("Responses terminal tool completion", () => {
  it.each([
    "completed",
    "completed-without-ciphertext",
    "completed-null-ciphertext",
    "length",
    "output-limit-active",
    "output-limit-rejected",
    "conflicting-status",
    "malformed-sibling",
    "content-filter",
    "failed",
  ])("delivers already-completed async calls on %s", async (ending) => {
    const reasoning = { type: "reasoning", id: "rs_deferred", summary: [] };
    const encrypted = !ending.startsWith("completed-");
    const completedReasoning = {
      ...reasoning,
      ...(ending === "completed-without-ciphertext"
        ? {}
        : { encrypted_content: encrypted ? "synthetic-ciphertext" : null }),
    };
    const call = tool(1, { async: true });
    const pendingSibling = [
      "output-limit-active",
      "output-limit-rejected",
      "conflicting-status",
      "malformed-sibling",
    ].includes(ending);
    const terminalOutput = [
      completedReasoning,
      call,
      ...(pendingSibling
        ? [tool(2, ending === "malformed-sibling" ? { arguments: "{" } : { status: "incomplete" })]
        : []),
    ];
    const isIncomplete =
      ending.startsWith("output-limit") ||
      ["length", "conflicting-status", "content-filter"].includes(ending);
    const terminalEvent =
      ending === "failed"
        ? {
            type: "response.failed",
            response: {
              id: "resp_deferred",
              status: "failed",
              error: { code: "server_error", message: "Synthetic failure" },
            },
          }
        : isIncomplete
          ? {
              type: "response.incomplete",
              response: {
                id: "resp_deferred",
                status: ending === "conflicting-status" ? "completed" : "incomplete",
                incomplete_details: {
                  reason: ending === "content-filter" ? "content_filter" : "max_output_tokens",
                },
                output: terminalOutput,
              },
            }
          : completed("resp_deferred", terminalOutput);
    const result = await runFixture(
      [
        { type: "response.output_item.added", output_index: 0, item: reasoning },
        { type: "response.output_item.done", output_index: 0, item: reasoning },
        added(1, { async: true }),
        done(1, { async: true }),
        ...(pendingSibling ? [added(2)] : []),
        ...(ending === "output-limit-rejected" ? [done(2, { status: "incomplete" })] : []),
        terminalEvent,
      ],
      { asyncToolExecution: true },
    );
    expect(result.events.filter((event) => event.type === "toolcall_end")).toEqual([
      { type: "toolcall_end", contentIndex: 1 },
    ]);
    expect(result.error === null).toBe(
      ending.startsWith("completed") || ending === "length" || ending === "content-filter",
    );
    if (ending === "content-filter") {
      expect(result.stopReason).toBe("error");
    }
    expect(result.content[0]).toMatchObject({
      type: "thinking",
      encrypted: ending === "failed" ? false : encrypted,
    });
  });

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

  it("completes an unindexed call exactly once when its item-done event is missing", async () => {
    const item = tool(0, { arguments: '{"slot":0,"id":9007199254740993}' });
    const result = await runFixture([
      { ...added(0), output_index: undefined },
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
        id: "call_0|fc_0",
        name: "lookup",
        arguments: { slot: 0, id: "9007199254740993" },
        partialJson: false,
      },
    ]);
  });

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
      done(0),
      added(1),
      completed("resp_completed_conflict", [tool(0, { call_id: "call_conflicting" }), tool(1)]),
    ]);
    expect(result.error).toBe("Responses stream changed output item identity");
    expect(result.events.filter((event) => event.type === "toolcall_end")).toEqual([
      { type: "toolcall_end", contentIndex: 0 },
    ]);
  });

  it("rejects a terminal duplicate call without completing the active call", async () => {
    const result = await runFixture([added(0), completed("resp_unresolved", [tool(0), tool(0)])]);
    expect(result.error).not.toBeNull();
    expect(result.events.filter((event) => event.type === "toolcall_end")).toEqual([]);
  });

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
      argumentEvent("delta", 0, { delta: streamedArgs }),
      argumentEvent("done", 0, { name: "lookup", arguments: streamedArgs }),
      done(0, { arguments: doneArgs }),
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
      argumentEvent("delta", 0, { delta: streamedArgs }),
      added(1),
      // An unroutable delta invalidates both otherwise complete argument buffers.
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_unknown",
        delta: streamedArgs,
      },
      done(0, { arguments: doneArgs }),
      completed("resp_unreliable", [tool(0, { arguments: doneArgs }), tool(1)]),
    ]);
    expect(result.error).toBeNull();
    const toolCall = result.content[0] as { arguments: unknown };
    expect(toolCall.arguments).toEqual({ slot: 0 });
  });
});

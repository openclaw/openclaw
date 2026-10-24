import { expect, it } from "vitest";
import {
  blockEvent,
  completed,
  outputItem,
  runFixture,
  tool as responseTool,
  toolCall,
} from "./openai-responses-stream-parity.test-helpers.js";

const tool = (slot: number, overrides: Record<string, unknown> = {}) => ({
  ...responseTool(String(slot), JSON.stringify({ slot }), "completed"),
  ...overrides,
});
const added = (slot: number, overrides: Record<string, unknown> = {}) =>
  outputItem("added", tool(slot, { arguments: "", status: "in_progress", ...overrides }), slot);
const done = (slot: number, overrides: Record<string, unknown> = {}) =>
  outputItem("done", tool(slot, overrides), slot);
const argumentEvent = (type: string, slot: number, fields: Record<string, unknown>) => ({
  type: `response.function_call_arguments.${type}`,
  output_index: slot,
  item_id: `fc_${slot}`,
  ...fields,
});
const cipher = "synthetic-ciphertext";

it.each([
  ["completed", cipher, "completed", undefined],
  ["completed-without-ciphertext", undefined, "completed", undefined],
  ["completed-null-ciphertext", null, "completed", undefined],
  ["length", cipher, "incomplete", undefined],
  ["output-limit-active", cipher, "incomplete", "active"],
  ["output-limit-rejected", cipher, "incomplete", "rejected"],
  ["conflicting-status", cipher, "incomplete", "active"],
  ["malformed-sibling", cipher, "completed", "malformed"],
  ["content-filter", cipher, "incomplete", undefined],
  ["failed", cipher, "failed", undefined],
] as const)(
  "delivers already-completed async calls on %s",
  async (ending, ciphertext, terminal, sibling) => {
    const reasoning = { type: "reasoning", id: "rs_deferred", summary: [] };
    const terminalOutput = [
      { ...reasoning, ...(ciphertext === undefined ? {} : { encrypted_content: ciphertext }) },
      tool(1, { async: true }),
      ...(sibling
        ? [tool(2, sibling === "malformed" ? { arguments: "{" } : { status: "incomplete" })]
        : []),
    ];
    const terminalEvent =
      terminal === "completed"
        ? completed("resp", terminalOutput)
        : {
            type: `response.${terminal}`,
            response: {
              id: "resp",
              status: ending === "conflicting-status" ? "completed" : terminal,
              ...(terminal === "failed"
                ? { error: { code: "server_error", message: "Synthetic failure" } }
                : {
                    output: terminalOutput,
                    incomplete_details: {
                      reason: ending === "content-filter" ? "content_filter" : "max_output_tokens",
                    },
                  }),
            },
          };
    const result = await runFixture(
      [
        { type: "response.output_item.added", output_index: 0, item: reasoning },
        { type: "response.output_item.done", output_index: 0, item: reasoning },
        added(1, { async: true }),
        done(1, { async: true }),
        ...(sibling ? [added(2)] : []),
        ...(sibling === "rejected" ? [done(2, { status: "incomplete" })] : []),
        terminalEvent,
      ],
      { asyncToolExecution: true },
    );
    expect(result.events.filter((event) => event.type === "toolcall_end")).toEqual([
      blockEvent("toolcall_end", 1),
    ]);
    expect(result.error === null).toBe(!sibling && terminal !== "failed");
    if (ending === "content-filter") {
      expect(result.stopReason).toBe("error");
    }
    expect(result.content[0]).toMatchObject({
      type: "thinking",
      encrypted: terminal !== "failed" && typeof ciphertext === "string",
    });
  },
);

it.each([
  [
    "anonymous unindexed completions before ambiguous terminal matching",
    [
      ...[0, 1].flatMap((slot) => {
        const anonymous = { id: undefined, call_id: undefined };
        return [
          { ...added(slot, anonymous), output_index: undefined },
          { type: "response.output_item.done", item: tool(slot, anonymous) },
        ];
      }),
      completed("resp", [tool(0), tool(1)]),
    ],
    expect.any(String),
  ],
  [
    "duplicate terminal calls",
    [added(0), completed("resp", [tool(0), tool(0)])],
    expect.any(String),
  ],
  [
    "active tools from an incomplete response",
    [
      added(0),
      {
        type: "response.incomplete",
        response: { id: "resp", status: "incomplete", output: [tool(0)] },
      },
    ],
    "Responses stream completed with unresolved tool calls",
  ],
] as const)("rejects %s without publishing tool completion", async (_name, events, error) => {
  const result = await runFixture(events);
  expect(result.error).toEqual(error);
  expect(result.events.filter((event) => event.type === "toolcall_end")).toEqual([]);
});

it("completes an unindexed call exactly once when its item-done event is missing", async () => {
  const item = tool(0, { arguments: '{"slot":0,"id":9007199254740993}' });
  const result = await runFixture([
    { ...added(0), output_index: undefined },
    completed("resp", [item]),
  ]);
  expect(result.error).toBeNull();
  expect(result.stopReason).toBe("toolUse");
  expect(result.events).toEqual([blockEvent("toolcall_start"), blockEvent("toolcall_end")]);
  expect(result.content).toEqual([
    toolCall("call_0|fc_0", "lookup", { slot: 0, id: "9007199254740993" }),
  ]);
});

it.each([
  ["malformed arguments", { arguments: '{"slot":' }],
  ["incomplete status", { status: "incomplete" }],
  ["changed name", { name: "delete_record" }],
])("rejects a terminal batch with later %s before any tool completes", async (_name, override) => {
  const result = await runFixture([
    added(0),
    added(1),
    completed("resp", [tool(0), tool(1, override)]),
  ]);
  expect(result.error).not.toBeNull();
  expect(result.events.filter((event) => event.type === "toolcall_end")).toEqual([]);
});

it("rejects a changed completed call identity before another active call completes", async () => {
  const result = await runFixture([
    done(0),
    added(1),
    completed("resp", [tool(0, { call_id: "call_conflicting" }), tool(1)]),
  ]);
  expect(result.error).toBe("Responses stream changed output item identity");
  expect(result.events.filter((event) => event.type === "toolcall_end")).toEqual([
    blockEvent("toolcall_end"),
  ]);
});

it.each([false, true])(
  "prefers streamed arguments unless marked unreliable (%s)",
  async (unreliable) => {
    const streamedArgs = JSON.stringify(
      unreliable ? { slot: 9 } : { if_match: '"rev-4"', object_id: "x" },
    );
    const doneArgs = JSON.stringify(
      unreliable ? { slot: 0 } : { if_match: '"rev-1"', object_id: "x" },
    );
    const result = await runFixture([
      added(0),
      argumentEvent("delta", 0, { delta: streamedArgs }),
      ...(unreliable
        ? [
            added(1),
            {
              // An unroutable delta invalidates both otherwise complete argument buffers.
              type: "response.function_call_arguments.delta",
              item_id: "fc_unknown",
              delta: streamedArgs,
            },
          ]
        : [argumentEvent("done", 0, { name: "lookup", arguments: streamedArgs })]),
      done(0, { arguments: doneArgs }),
      completed("resp", [
        tool(0, { arguments: unreliable ? doneArgs : streamedArgs }),
        ...(unreliable ? [tool(1)] : []),
      ]),
    ]);
    expect(result.error).toBeNull();
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        arguments: unreliable ? { slot: 0 } : { if_match: '"rev-4"', object_id: "x" },
      }),
    );
  },
);

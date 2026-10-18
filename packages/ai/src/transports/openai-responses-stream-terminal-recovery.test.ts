import { describe, expect, it } from "vitest";
import {
  completed,
  expected,
  message,
  outputItem,
  outputTextDelta,
  outputTextPart,
  reasoning,
  runFixture,
  startedMessage,
  textEvents,
  tool,
  toolCall,
  type ParityFixture,
} from "./openai-responses-stream-parity.test-helpers.js";

const rejectedTerminalToolFixture = (params: {
  name: string;
  status: "completed" | "incomplete";
  arguments: string;
  error: string;
}): ParityFixture => {
  const commentary = message("msg_before_rejected_tool", "Checking...", "commentary");
  return {
    name: params.name,
    events: [
      outputItem("done", commentary, 0),
      completed("resp_rejected_terminal_tool", [
        commentary,
        tool("rejected_terminal", params.arguments, params.status),
      ]),
    ],
    canonical: expected(
      "resp_rejected_terminal_tool",
      textEvents("Checking..."),
      [{ type: "text", text: "Checking..." }],
      { error: params.error },
    ),
  };
};

const rejectedTerminalToolBatchFixture = (params: {
  name: string;
  status: "completed" | "incomplete";
  arguments: string;
  error: string;
  toolName?: string;
}): ParityFixture => ({
  name: params.name,
  events: [
    completed("resp_rejected_terminal_tool_batch", [
      tool("valid_before_rejection", '{"q":"valid"}', "completed"),
      tool("rejected_after_valid", params.arguments, params.status, params.toolName ?? "lookup"),
    ]),
  ],
  canonical: expected("resp_rejected_terminal_tool_batch", [], [], { error: params.error }),
});

const rejectedStreamedToolFixture = (params: {
  name: string;
  status: "completed" | "incomplete";
  arguments?: string;
  error: string;
  started?: boolean;
}): ParityFixture => {
  const item = {
    id: "fc_rejected_streamed",
    call_id: "call_rejected_streamed",
    type: "function_call",
    name: "lookup",
    ...(params.arguments === undefined ? {} : { arguments: params.arguments }),
    status: params.status,
  };
  const started = params.started
    ? [
        outputItem("added", { ...item, arguments: "", status: "in_progress" }, 0),
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: item.id,
          delta: "{",
        },
      ]
    : [];
  return {
    name: params.name,
    events: [
      ...started,
      { type: "response.output_item.done", output_index: 0, item },
      completed("resp_rejected_streamed_tool", [item]),
    ],
    canonical: expected(
      "resp_rejected_streamed_tool",
      params.started
        ? [
            { type: "toolcall_start", contentIndex: 0 },
            { type: "toolcall_delta", contentIndex: 0, delta: "{" },
          ]
        : [],
      params.started ? [toolCall("call_rejected_streamed|fc_rejected_streamed", "lookup", {})] : [],
      { error: params.error, stopReason: params.started ? "toolUse" : "stop" },
    ),
  };
};

const unsafeIntegerToolFixture = (source: "streamed" | "terminal"): ParityFixture => {
  const item = {
    id: "fc_unsafe_integer",
    call_id: "call_unsafe_integer",
    type: "function_call",
    name: "send_message",
    arguments:
      '{"to":1481220477346119781,"safe":42,"maxSafe":9007199254740991,"nested":{"ids":[9007199254740993,-9007199254740992]}}',
    status: "completed",
  };
  const streamed =
    source === "streamed"
      ? [
          outputItem("added", { ...item, arguments: "", status: "in_progress" }, 0),
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: item.id,
            delta: '{"to":',
          },
          { type: "response.output_item.done", output_index: 0, item },
        ]
      : [];
  return {
    name: `${source} completed tool arguments preserve unsafe integers`,
    events: [...streamed, completed("resp_unsafe_integer_tool", [item])],
    canonical: expected(
      "resp_unsafe_integer_tool",
      [
        { type: "toolcall_start", contentIndex: 0 },
        ...(source === "streamed"
          ? [{ type: "toolcall_delta", contentIndex: 0, delta: '{"to":' }]
          : []),
        { type: "toolcall_end", contentIndex: 0 },
      ],
      [
        {
          type: "toolCall",
          id: "call_unsafe_integer|fc_unsafe_integer",
          name: "send_message",
          arguments: {
            to: "1481220477346119781",
            safe: 42,
            maxSafe: 9007199254740991,
            nested: { ids: ["9007199254740993", "-9007199254740992"] },
          },
          partialJson: false,
        },
      ],
      { stopReason: "toolUse" },
    ),
  };
};

const rejectedOutOfOrderTerminalFixture = (
  state: "completed" | "started" | "reasoning",
): ParityFixture => {
  const later =
    state === "reasoning"
      ? reasoning("rs_later_already_streamed", "Thinking...")
      : message("msg_later_already_streamed", "Final answer", "final_answer");
  const streamed =
    state === "completed" || state === "reasoning"
      ? [outputItem("done", later, 1)]
      : [
          outputItem("added", { ...later, status: "in_progress", content: [] }, 1),
          outputTextDelta(later.id, "Final answer", 1),
        ];
  return {
    name: `terminal recovery rejects missing output before a ${state} item`,
    events: [
      ...streamed,
      completed("resp_out_of_order_recovery", [
        message("msg_earlier_missing", "Working...", "commentary"),
        later,
      ]),
    ],
    canonical: expected(
      "resp_out_of_order_recovery",
      state === "reasoning"
        ? [
            { type: "thinking_start", contentIndex: 0 },
            { type: "thinking_end", contentIndex: 0, content: "Thinking..." },
          ]
        : [
            { type: "text_start", contentIndex: 0 },
            ...(state === "completed"
              ? [{ type: "text_end", contentIndex: 0, content: "Final answer" }]
              : [{ type: "text_delta", contentIndex: 0, delta: "Final answer" }]),
          ],
      state === "reasoning"
        ? [{ type: "thinking", thinking: "Thinking...", encrypted: false }]
        : [{ type: "text", text: "Final answer" }],
      { error: "Responses stream omitted an output item before completed output" },
    ),
  };
};

const leadingFixtures: ParityFixture[] = [
  {
    name: "terminal final answer recovery preserves streamed commentary",
    events: [
      outputItem("done", message("msg_streamed_commentary", "Working on it...", "commentary"), 0),
      completed("resp_commentary_terminal_answer", [
        message("msg_streamed_commentary", "Working on it...", "commentary"),
        message("msg_terminal_answer", "Final answer", "final_answer"),
      ]),
    ],
    canonical: expected(
      "resp_commentary_terminal_answer",
      [...textEvents("Working on it..."), ...textEvents("Final answer", 1)],
      [
        { type: "text", text: "Working on it..." },
        { type: "text", text: "Final answer" },
      ],
    ),
  },
  {
    name: "terminal tool recovery preserves streamed commentary",
    events: [
      outputItem("done", message("msg_tool_commentary", "Checking...", "commentary"), 0),
      completed("resp_commentary_terminal_tool", [
        message("msg_tool_commentary", "Checking...", "commentary"),
        tool("after_commentary", '{"q":"x"}', "completed"),
      ]),
    ],
    canonical: expected(
      "resp_commentary_terminal_tool",
      [
        ...textEvents("Checking..."),
        { type: "toolcall_start", contentIndex: 1 },
        { type: "toolcall_end", contentIndex: 1 },
      ],
      [
        { type: "text", text: "Checking..." },
        toolCall("call_after_commentary|fc_after_commentary", "lookup", { q: "x" }),
      ],
      { stopReason: "toolUse" },
    ),
  },
  {
    name: "terminal snapshot does not duplicate streamed commentary or final answer",
    events: [
      outputItem("done", message("msg_complete_commentary", "Checking...", "commentary"), 0),
      outputItem("done", message("msg_complete_answer", "Done.", "final_answer"), 1),
      completed("resp_complete_messages", [
        message("msg_complete_commentary", "Checking...", "commentary"),
        message("msg_complete_answer", "Done.", "final_answer"),
      ]),
    ],
    canonical: expected(
      "resp_complete_messages",
      [...textEvents("Checking..."), ...textEvents("Done.", 1)],
      [
        { type: "text", text: "Checking..." },
        { type: "text", text: "Done." },
      ],
    ),
  },
  rejectedTerminalToolFixture({
    name: "terminal incomplete tool snapshot after streamed commentary is rejected",
    status: "incomplete",
    arguments: '{"q":"x"}',
    error: "Responses stream completed with an incomplete terminal tool call",
  }),
  rejectedTerminalToolFixture({
    name: "terminal malformed tool arguments after streamed commentary are rejected",
    status: "completed",
    arguments: '{"q":',
    error: "Responses stream completed tool call with invalid JSON arguments",
  }),
];

const toolOnlyFixtures: ParityFixture[] = [
  rejectedStreamedToolFixture({
    name: "streamed malformed tool arguments never complete their started call",
    status: "completed",
    arguments: '{"q":',
    error: "Responses stream completed tool call with invalid JSON arguments",
    started: true,
  }),
  rejectedStreamedToolFixture({
    name: "streamed non-object tool arguments never start a call",
    status: "completed",
    arguments: "[]",
    error: "Responses stream completed tool call with invalid JSON arguments",
  }),
  rejectedStreamedToolFixture({
    name: "streamed missing tool arguments never fabricate an empty call",
    status: "completed",
    error: "Responses stream completed tool call with invalid JSON arguments",
  }),
  rejectedStreamedToolFixture({
    name: "streamed incomplete tool calls never start a call",
    status: "incomplete",
    arguments: '{"q":"x"}',
    error: "Responses stream completed with an incomplete terminal tool call",
  }),
  unsafeIntegerToolFixture("streamed"),
  unsafeIntegerToolFixture("terminal"),
  rejectedTerminalToolBatchFixture({
    name: "terminal tool batch rejects a later incomplete call before executing earlier calls",
    status: "incomplete",
    arguments: '{"q":"incomplete"}',
    error: "Responses stream completed with an incomplete terminal tool call",
  }),
  rejectedTerminalToolBatchFixture({
    name: "terminal tool batch rejects later malformed arguments before executing earlier calls",
    status: "completed",
    arguments: '{"q":',
    error: "Responses stream completed tool call with invalid JSON arguments",
  }),
  rejectedTerminalToolBatchFixture({
    name: "terminal tool batch rejects a later blank function name before executing earlier calls",
    status: "completed",
    arguments: '{"q":"x"}',
    toolName: "",
    error: "Responses stream completed tool call without a function name",
  }),
  {
    name: "terminal tool snapshots preserve optional SDK completion status",
    events: [
      completed("resp_terminal_tool_optional_status", [tool("optional_status", '{"q":"x"}')]),
    ],
    canonical: expected(
      "resp_terminal_tool_optional_status",
      [
        { type: "toolcall_start", contentIndex: 0 },
        { type: "toolcall_end", contentIndex: 0 },
      ],
      [toolCall("call_optional_status|fc_optional_status", "lookup", { q: "x" })],
      { stopReason: "toolUse" },
    ),
  },
];

const trailingFixtures: ParityFixture[] = [
  rejectedOutOfOrderTerminalFixture("completed"),
  rejectedOutOfOrderTerminalFixture("started"),
  rejectedOutOfOrderTerminalFixture("reasoning"),
  {
    name: "incomplete terminal recovery preserves completed tool-call ordering",
    events: [
      outputItem("done", tool("completed_before_incomplete", '{"q":"x"}', "completed"), 1),
      {
        type: "response.incomplete",
        response: {
          id: "resp_incomplete_out_of_order",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [
            message("msg_earlier_missing_before_tool", "Working...", "commentary"),
            tool("completed_before_incomplete", '{"q":"x"}', "completed"),
          ],
        },
      },
    ],
    canonical: expected(
      "resp_incomplete_out_of_order",
      [
        { type: "toolcall_start", contentIndex: 0 },
        { type: "toolcall_end", contentIndex: 0 },
      ],
      [
        toolCall("call_completed_before_incomplete|fc_completed_before_incomplete", "lookup", {
          q: "x",
        }),
      ],
      {
        error: "Responses stream omitted an output item before completed output",
        stopReason: "length",
      },
    ),
  },
  {
    name: "terminal snapshot closes an already started empty message",
    events: [
      outputItem("added", startedMessage("msg_started_empty"), 0),
      completed("resp_started_empty", [
        {
          id: "msg_started_empty",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [],
        },
      ]),
    ],
    canonical: expected("resp_started_empty", textEvents(""), [{ type: "text", text: "" }]),
  },
  {
    name: "terminal snapshot completes an unfinished streamed message once",
    events: [
      outputItem("added", startedMessage("msg_unfinished_terminal", "final_answer"), 0),
      outputTextPart("msg_unfinished_terminal"),
      outputTextDelta("msg_unfinished_terminal", "Partial"),
      completed("resp_unfinished_terminal_message", [
        message("msg_unfinished_terminal", "Partial answer", "final_answer"),
      ]),
    ],
    canonical: expected(
      "resp_unfinished_terminal_message",
      [
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "Partial" },
        { type: "text_delta", contentIndex: 0, delta: " answer" },
        { type: "text_end", contentIndex: 0, content: "Partial answer" },
      ],
      [{ type: "text", text: "Partial answer" }],
    ),
  },
  {
    name: "terminal reasoning backfill follows the completed output slot",
    events: [
      outputItem("added", { id: "rs_backfill", type: "reasoning", summary: [] }, 0),
      outputItem(
        "done",
        {
          id: "rs_backfill",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Checking the answer." }],
        },
        0,
      ),
      completed("resp_reasoning_backfill", [
        {
          id: "rs_backfill",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Checking the answer." }],
          encrypted_content: "fixture-reasoning-ciphertext",
        },
      ]),
    ],
    canonical: expected(
      "resp_reasoning_backfill",
      [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_end", contentIndex: 0, content: "Checking the answer." },
      ],
      [{ type: "thinking", thinking: "Checking the answer.", encrypted: true }],
    ),
  },
  {
    name: "equal text in distinct output slots remains distinct",
    events: [
      ...[0, 1].flatMap((outputIndex) => [
        {
          type: "response.output_item.added",
          output_index: outputIndex,
          item: { id: `msg_equal_${outputIndex}`, type: "message", content: [] },
        },
        {
          type: "response.output_item.done",
          output_index: outputIndex,
          item: {
            id: `msg_equal_${outputIndex}`,
            type: "message",
            content: [{ type: "output_text", text: "Again." }],
          },
        },
      ]),
      completed(
        "resp_equal_messages",
        [0, 1].map((outputIndex) => ({
          id: `msg_equal_${outputIndex}`,
          type: "message",
          content: [{ type: "output_text", text: "Again." }],
        })),
      ),
    ],
    canonical: expected(
      "resp_equal_messages",
      [...textEvents("Again."), ...textEvents("Again.", 1)],
      [
        { type: "text", text: "Again." },
        { type: "text", text: "Again." },
      ],
    ),
  },
];

const fixtures = [...leadingFixtures, ...toolOnlyFixtures, ...trailingFixtures];
const rotatedFixtures = [...leadingFixtures, ...trailingFixtures];

describe.each(["stable", "rotated"])("Responses terminal recovery with %s item IDs", (ids) => {
  it.each(ids === "rotated" ? rotatedFixtures : fixtures)("$name", async (fixture) => {
    let sequence = 0;
    const events: ParityFixture["events"] = JSON.parse(
      JSON.stringify(fixture.events),
      (key, value: unknown) =>
        ids === "rotated" &&
        (key === "id" || key === "item_id") &&
        typeof value === "string" &&
        /^(msg|rs)_/.test(value)
          ? `${value}_event_${sequence++}`
          : value,
    );
    expect(await runFixture(events)).toEqual(fixture.canonical);
  });
});

it.each(["type", "call_id"])("rejects terminal output that changes its %s", async (field) => {
  const streamed = {
    type: "function_call",
    id: "fc_original",
    call_id: "call_original",
    name: "lookup",
    arguments: "{}",
    status: "completed",
  };
  const terminal =
    field === "type"
      ? { type: "message", id: "msg_changed", content: [{ type: "output_text", text: "Changed" }] }
      : { ...streamed, call_id: "call_changed" };
  const result = await runFixture([
    outputItem("done", streamed, 0),
    completed("resp_changed_identity", [terminal]),
  ]);
  expect(result.error).toBe("Responses stream changed output item identity");
  expect(result.content).toHaveLength(1);
  expect(result.events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);
});

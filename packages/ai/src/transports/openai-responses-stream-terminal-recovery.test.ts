import { describe, expect, it } from "vitest";
import {
  blockEvent,
  textBlock,
  thinkingBlock,
  thinkingEvents,
  completed,
  fixture as parityFixture,
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
import { argumentDelta } from "./openai-stream-cases.test-support.js";

const rejectedTerminalToolFixture = (params: {
  name: string;
  status: "completed" | "incomplete";
  arguments: string;
  error: string;
}): ParityFixture => {
  const commentary = message("msg_before_rejected_tool", "Checking...", "commentary");
  return parityFixture(
    params.name,
    [
      outputItem("done", commentary, 0),
      completed("resp", [commentary, tool("rejected_terminal", params.arguments, params.status)]),
    ],
    textEvents("Checking..."),
    [textBlock("Checking...")],
    {
      error: params.error,
    },
  );
};

const rejectedTerminalToolBatchFixture = (params: {
  name: string;
  status: "completed" | "incomplete";
  arguments: string;
  error: string;
  toolName?: string;
}): ParityFixture =>
  parityFixture(
    params.name,
    [
      completed("resp", [
        tool("valid_before_rejection", '{"q":"valid"}', "completed"),
        tool("rejected_after_valid", params.arguments, params.status, params.toolName ?? "lookup"),
      ]),
    ],
    [],
    [],
    { error: params.error },
  );

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
        argumentDelta(item.id, "{"),
      ]
    : [];
  return parityFixture(
    params.name,
    [...started, outputItem("done", item, 0), completed("resp", [item])],
    params.started ? [blockEvent("toolcall_start"), blockEvent("toolcall_delta", 0, "{")] : [],
    params.started ? [toolCall("call_rejected_streamed|fc_rejected_streamed", "lookup", {})] : [],
    { error: params.error, stopReason: params.started ? "toolUse" : "stop" },
  );
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
          argumentDelta(item.id, '{"to":'),
          outputItem("done", item, 0),
        ]
      : [];
  return parityFixture(
    `${source} completed tool arguments preserve unsafe integers`,
    [...streamed, completed("resp", [item])],
    [
      blockEvent("toolcall_start"),
      ...(source === "streamed"
        ? [{ type: "toolcall_delta", contentIndex: 0, delta: '{"to":' }]
        : []),
      blockEvent("toolcall_end"),
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
  );
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
  return parityFixture(
    `terminal recovery rejects missing output before a ${state} item`,
    [
      ...streamed,
      completed("resp", [message("msg_earlier_missing", "Working...", "commentary"), later]),
    ],
    state === "reasoning"
      ? thinkingEvents("Thinking...")
      : [
          blockEvent("text_start"),
          ...(state === "completed"
            ? [blockEvent("text_end", 0, "Final answer")]
            : [blockEvent("text_delta", 0, "Final answer")]),
        ],
    state === "reasoning" ? [thinkingBlock("Thinking...")] : [textBlock("Final answer")],
    { error: "Responses stream omitted an output item before completed output" },
  );
};

const leadingFixtures: ParityFixture[] = [
  parityFixture(
    "terminal final answer recovery preserves streamed commentary",
    [
      outputItem("done", message("msg_streamed_commentary", "Working on it...", "commentary"), 0),
      completed("resp", [
        message("msg_streamed_commentary", "Working on it...", "commentary"),
        message("msg_terminal_answer", "Final answer", "final_answer"),
      ]),
    ],
    [...textEvents("Working on it..."), ...textEvents("Final answer", 1)],
    [textBlock("Working on it..."), textBlock("Final answer")],
  ),
  parityFixture(
    "terminal tool recovery preserves streamed commentary",
    [
      outputItem("done", message("msg_tool_commentary", "Checking...", "commentary"), 0),
      completed("resp", [
        message("msg_tool_commentary", "Checking...", "commentary"),
        tool("after_commentary", '{"q":"x"}', "completed"),
      ]),
    ],
    [...textEvents("Checking..."), blockEvent("toolcall_start", 1), blockEvent("toolcall_end", 1)],
    [
      textBlock("Checking..."),
      toolCall("call_after_commentary|fc_after_commentary", "lookup", { q: "x" }),
    ],
    { stopReason: "toolUse" },
  ),
  parityFixture(
    "terminal snapshot does not duplicate streamed commentary or final answer",
    [
      outputItem("done", message("msg_complete_commentary", "Checking...", "commentary"), 0),
      outputItem("done", message("msg_complete_answer", "Done.", "final_answer"), 1),
      completed("resp", [
        message("msg_complete_commentary", "Checking...", "commentary"),
        message("msg_complete_answer", "Done.", "final_answer"),
      ]),
    ],
    [...textEvents("Checking..."), ...textEvents("Done.", 1)],
    [textBlock("Checking..."), textBlock("Done.")],
  ),
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
  parityFixture(
    "terminal tool snapshots preserve optional SDK completion status",
    [completed("resp", [tool("optional_status", '{"q":"x"}')])],
    [blockEvent("toolcall_start"), blockEvent("toolcall_end")],
    [toolCall("call_optional_status|fc_optional_status", "lookup", { q: "x" })],
    { stopReason: "toolUse" },
  ),
];

const trailingFixtures: ParityFixture[] = [
  rejectedOutOfOrderTerminalFixture("completed"),
  rejectedOutOfOrderTerminalFixture("started"),
  rejectedOutOfOrderTerminalFixture("reasoning"),
  parityFixture(
    "incomplete terminal recovery preserves completed tool-call ordering",
    [
      outputItem("done", tool("completed_before_incomplete", '{"q":"x"}', "completed"), 1),
      {
        type: "response.incomplete",
        response: {
          id: "resp",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [
            message("msg_earlier_missing_before_tool", "Working...", "commentary"),
            tool("completed_before_incomplete", '{"q":"x"}', "completed"),
          ],
        },
      },
    ],
    [blockEvent("toolcall_start"), blockEvent("toolcall_end")],
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
  parityFixture(
    "terminal snapshot closes an already started empty message",
    [
      outputItem("added", startedMessage("msg_started_empty"), 0),
      completed("resp", [{ ...message("msg_started_empty", ""), content: [] }]),
    ],
    textEvents(""),
    [textBlock("")],
  ),
  parityFixture(
    "terminal snapshot completes an unfinished streamed message once",
    [
      outputItem("added", startedMessage("msg_unfinished_terminal", "final_answer"), 0),
      outputTextPart("msg_unfinished_terminal"),
      outputTextDelta("msg_unfinished_terminal", "Partial"),
      completed("resp", [message("msg_unfinished_terminal", "Partial answer", "final_answer")]),
    ],
    textEvents("Partial answer", 0, ["Partial", " answer"]),
    [textBlock("Partial answer")],
  ),
  parityFixture(
    "terminal reasoning backfill follows the completed output slot",
    [
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
      completed("resp", [
        {
          id: "rs_backfill",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Checking the answer." }],
          encrypted_content: "fixture-reasoning-ciphertext",
        },
      ]),
    ],
    thinkingEvents("Checking the answer."),
    [thinkingBlock("Checking the answer.", true)],
  ),
  parityFixture(
    "equal text in distinct output slots remains distinct",
    [
      ...[0, 1].flatMap((outputIndex) => [
        outputItem(
          "added",
          { id: `msg_equal_${outputIndex}`, type: "message", content: [] },
          outputIndex,
        ),
        outputItem(
          "done",
          {
            id: `msg_equal_${outputIndex}`,
            type: "message",
            content: [{ type: "output_text", text: "Again." }],
          },
          outputIndex,
        ),
      ]),
      completed(
        "resp",
        [0, 1].map((outputIndex) => ({
          id: `msg_equal_${outputIndex}`,
          type: "message",
          content: [{ type: "output_text", text: "Again." }],
        })),
      ),
    ],
    [...textEvents("Again."), ...textEvents("Again.", 1)],
    [textBlock("Again."), textBlock("Again.")],
  ),
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
  const result = await runFixture([outputItem("done", streamed, 0), completed("resp", [terminal])]);
  expect(result.error).toBe("Responses stream changed output item identity");
  expect(result.content).toHaveLength(1);
  expect(result.events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);
});

it.each([undefined, null, "standard", "daybreak_blue", "daybreak_red", "unknown"])(
  "reports only the provider's terminal access program: %s",
  async (program) => {
    const terminal = completed("resp_access", []);
    const result = await runFixture([
      { ...terminal, response: { ...terminal.response, access_programs: { cyber: program } } },
    ]);
    expect(result.error).toBeNull();
    expect(result.responseAccessProgram).toBe(program === "unknown" ? undefined : program);
  },
);

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

const fixtures: ParityFixture[] = [
  {
    name: "indexed interleaved reasoning items",
    events: [
      outputItem("added", reasoning("rs_0"), 0),
      outputItem("added", reasoning("rs_1"), 1),
      { type: "response.reasoning_text.delta", output_index: 0, item_id: "rs_0", delta: "A" },
      { type: "response.reasoning_text.delta", output_index: 1, item_id: "rs_1", delta: "B" },
      outputItem("done", reasoning("rs_1"), 1),
      outputItem("done", reasoning("rs_0"), 0),
      completed("resp_interleaved"),
    ],
    canonical: expected(
      "resp_interleaved",
      [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_start", contentIndex: 1 },
        { type: "thinking_delta", contentIndex: 0, delta: "A" },
        { type: "thinking_delta", contentIndex: 1, delta: "B" },
        { type: "thinking_end", contentIndex: 1, content: "B" },
        { type: "thinking_end", contentIndex: 0, content: "A" },
      ],
      [
        { type: "thinking", thinking: "A", encrypted: false },
        { type: "thinking", thinking: "B", encrypted: false },
      ],
    ),
  },
  {
    name: "reasoning summary text and part completion preserve delta order",
    events: [
      outputItem("added", reasoning("rs_summary"), 0),
      {
        type: "response.reasoning_summary_part.added",
        output_index: 0,
        item_id: "rs_summary",
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      },
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        item_id: "rs_summary",
        summary_index: 0,
        delta: "summary",
      },
      {
        type: "response.reasoning_summary_part.done",
        output_index: 0,
        item_id: "rs_summary",
        summary_index: 0,
        part: { type: "summary_text", text: "summary" },
      },
      outputItem("done", reasoning("rs_summary", "summary"), 0),
      completed("resp_summary"),
    ],
    canonical: expected(
      "resp_summary",
      [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_delta", contentIndex: 0, delta: "summary" },
        { type: "thinking_delta", contentIndex: 0, delta: "\n\n" },
        { type: "thinking_end", contentIndex: 0, content: "summary" },
      ],
      [{ type: "thinking", thinking: "summary", encrypted: false }],
    ),
  },
  {
    name: "stream close without terminal response",
    events: [outputItem("done", message("msg_early", "early"), 0)],
    canonical: expected(null, textEvents("early"), [{ type: "text", text: "early" }], {
      error: "OpenAI Responses stream ended before a terminal response event",
    }),
  },
  {
    name: "terminal encrypted reasoning backfill",
    events: [
      outputItem("added", reasoning("rs_backfill"), 0),
      outputItem("done", reasoning("rs_backfill", "thought"), 0),
      completed("resp_backfill", [reasoning("rs_backfill", "thought", "encrypted")]),
    ],
    canonical: expected(
      "resp_backfill",
      [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_end", contentIndex: 0, content: "thought" },
      ],
      [{ type: "thinking", thinking: "thought", encrypted: true }],
    ),
  },
  {
    name: "null completed message content preserves streamed text",
    events: [
      outputItem("added", startedMessage("msg_null"), 0),
      outputTextPart("msg_null"),
      outputTextDelta("msg_null", "kept"),
      outputItem(
        "done",
        {
          id: "msg_null",
          type: "message",
          role: "assistant",
          status: "completed",
          content: null,
        },
        0,
      ),
      completed("resp_null"),
    ],
    canonical: expected(
      "resp_null",
      [
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "kept" },
        { type: "text_end", contentIndex: 0, content: "kept" },
      ],
      [{ type: "text", text: "kept" }],
    ),
  },
  {
    name: "finalized tool call drops streaming scratch",
    events: [
      outputItem("added", tool("scratch", "", "in_progress"), 0),
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "fc_scratch",
        delta: '{"q":"x"}',
      },
      outputItem("done", tool("scratch", '{"q":"x"}', "completed"), 0),
      completed("resp_scratch"),
    ],
    canonical: expected(
      "resp_scratch",
      [
        { type: "toolcall_start", contentIndex: 0 },
        { type: "toolcall_delta", contentIndex: 0, delta: '{"q":"x"}' },
        { type: "toolcall_end", contentIndex: 0 },
      ],
      [toolCall("call_scratch|fc_scratch", "lookup", { q: "x" })],
      { stopReason: "toolUse" },
    ),
  },
  {
    name: "reused indexed output slot fails closed",
    events: [
      outputItem("added", reasoning("rs_first"), 0),
      outputItem("added", reasoning("rs_second"), 0),
      completed("resp_reused"),
    ],
    canonical: expected(
      null,
      [{ type: "thinking_start", contentIndex: 0 }],
      [
        { type: "thinking", thinking: "", encrypted: false },
        { type: "thinking", thinking: "", encrypted: false },
      ],
      { error: "Responses stream reused active output index 0" },
    ),
  },
  {
    name: "deferred text materializes before an unindexed tool boundary",
    events: [
      outputItem("done", message("msg_before_tool", "Hello")),
      outputItem("added", startedMessage("msg_after_tool")),
      { type: "response.output_text.delta", item_id: "msg_after_tool", delta: "Hello again" },
      outputItem("done", tool("boundary", "{}", "completed")),
      outputItem("done", message("msg_after_tool", "Hello again")),
      completed("resp_tool_boundary"),
    ],
    canonical: expected(
      "resp_tool_boundary",
      [
        ...textEvents("Hello"),
        { type: "text_start", contentIndex: 1 },
        { type: "text_delta", contentIndex: 1, delta: "Hello again" },
        { type: "toolcall_start", contentIndex: 2 },
        { type: "toolcall_end", contentIndex: 2 },
        { type: "text_end", contentIndex: 1, content: "Hello again" },
      ],
      [
        { type: "text", text: "Hello" },
        { type: "text", text: "Hello again" },
        toolCall("call_boundary|fc_boundary", "lookup", {}),
      ],
      { stopReason: "toolUse" },
    ),
  },
  {
    name: "normal output text lifecycle",
    events: [
      outputItem("added", startedMessage("msg_text"), 0),
      outputTextPart("msg_text"),
      outputTextDelta("msg_text", "hello"),
      outputItem("done", message("msg_text", "hello"), 0),
      completed("resp_text", [message("msg_text", "hello")]),
    ],
    canonical: expected(
      "resp_text",
      [
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "hello" },
        { type: "text_end", contentIndex: 0, content: "hello" },
      ],
      [{ type: "text", text: "hello" }],
    ),
  },
  {
    name: "terminal-only completed message recovery",
    events: [completed("resp_terminal_text", [message("msg_terminal", "recovered")])],
    canonical: expected("resp_terminal_text", textEvents("recovered"), [
      { type: "text", text: "recovered" },
    ]),
  },
  {
    name: "terminal completed message recovery after multiple streamed reasoning blocks",
    events: [
      outputItem("added", reasoning("rs_before_multi_first"), 0),
      outputItem("done", reasoning("rs_before_multi_first", "first thought"), 0),
      outputItem("added", reasoning("rs_before_multi_second"), 1),
      outputItem("done", reasoning("rs_before_multi_second", "second thought"), 1),
      completed("resp_multi_reasoning_terminal_text", [
        reasoning("rs_before_multi_first", "first thought"),
        reasoning("rs_before_multi_second", "second thought"),
        message("msg_after_multiple_reasoning", "recovered final answer", "final_answer"),
      ]),
    ],
    canonical: expected(
      "resp_multi_reasoning_terminal_text",
      [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_end", contentIndex: 0, content: "first thought" },
        { type: "thinking_start", contentIndex: 1 },
        { type: "thinking_end", contentIndex: 1, content: "second thought" },
        ...textEvents("recovered final answer", 2),
      ],
      [
        { type: "thinking", thinking: "first thought", encrypted: false },
        { type: "thinking", thinking: "second thought", encrypted: false },
        { type: "text", text: "recovered final answer" },
      ],
    ),
  },
  {
    name: "terminal completed refusal recovery after streamed reasoning",
    events: [
      outputItem("added", reasoning("rs_before_refusal"), 0),
      outputItem("done", reasoning("rs_before_refusal", "thought"), 0),
      completed("resp_reasoning_terminal_refusal", [
        reasoning("rs_before_refusal", "thought"),
        {
          id: "msg_after_reasoning_refusal",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "refusal", refusal: "I cannot help with that." }],
        },
      ]),
    ],
    canonical: expected(
      "resp_reasoning_terminal_refusal",
      [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_end", contentIndex: 0, content: "thought" },
        ...textEvents("I cannot help with that.", 1),
      ],
      [
        { type: "thinking", thinking: "thought", encrypted: false },
        { type: "text", text: "I cannot help with that." },
      ],
    ),
  },
  {
    name: "streamed refusal uses the text delta lifecycle",
    events: [
      outputItem("added", startedMessage("msg_refusal"), 0),
      {
        type: "response.content_part.added",
        output_index: 0,
        item_id: "msg_refusal",
        content_index: 0,
        part: { type: "refusal", refusal: "" },
      },
      {
        type: "response.refusal.delta",
        output_index: 0,
        item_id: "msg_refusal",
        content_index: 0,
        delta: "I cannot",
      },
      {
        type: "response.refusal.delta",
        output_index: 0,
        item_id: "msg_refusal",
        content_index: 0,
        delta: " help.",
      },
      outputItem(
        "done",
        {
          id: "msg_refusal",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "refusal", refusal: "I cannot help." }],
        },
        0,
      ),
      completed("resp_refusal"),
    ],
    canonical: expected(
      "resp_refusal",
      [
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "I cannot" },
        { type: "text_delta", contentIndex: 0, delta: " help." },
        { type: "text_end", contentIndex: 0, content: "I cannot help." },
      ],
      [{ type: "text", text: "I cannot help." }],
    ),
  },
  {
    name: "terminal null message after streamed reasoning is ignored",
    events: [
      outputItem("added", reasoning("rs_terminal_null"), 0),
      outputItem("done", reasoning("rs_terminal_null", "thought"), 0),
      completed("resp_reasoning_terminal_null", [
        reasoning("rs_terminal_null", "thought"),
        {
          id: "msg_after_reasoning_null",
          type: "message",
          role: "assistant",
          status: "completed",
          content: null,
        },
      ]),
    ],
    canonical: expected(
      "resp_reasoning_terminal_null",
      [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_end", contentIndex: 0, content: "thought" },
      ],
      [{ type: "thinking", thinking: "thought", encrypted: false }],
    ),
  },
  {
    name: "terminal-only completed tool call recovery after streamed reasoning",
    events: [
      outputItem("added", reasoning("rs_before_tool"), 0),
      outputItem("done", reasoning("rs_before_tool", "thought"), 0),
      completed("resp_reasoning_terminal_tool", [
        reasoning("rs_before_tool", "thought"),
        tool("terminal", '{"q":"x"}', "completed"),
      ]),
    ],
    canonical: expected(
      "resp_reasoning_terminal_tool",
      [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_end", contentIndex: 0, content: "thought" },
        { type: "toolcall_start", contentIndex: 1 },
        { type: "toolcall_end", contentIndex: 1 },
      ],
      [
        { type: "thinking", thinking: "thought", encrypted: false },
        toolCall("call_terminal|fc_terminal", "lookup", { q: "x" }),
      ],
      { stopReason: "toolUse" },
    ),
  },
  {
    name: "output text delta without content part",
    events: [
      outputItem("added", startedMessage("msg_no_part"), 0),
      outputTextDelta("msg_no_part", "compatible"),
      outputItem("done", message("msg_no_part", "compatible"), 0),
      completed("resp_no_part"),
    ],
    canonical: expected(
      "resp_no_part",
      [
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "compatible" },
        { type: "text_end", contentIndex: 0, content: "compatible" },
      ],
      [{ type: "text", text: "compatible" }],
    ),
  },
  {
    name: "detailed response failure is terminal",
    events: [
      {
        type: "response.failed",
        sequence_number: 1,
        response: {
          id: "resp_failed",
          status: "failed",
          error: { code: "invalid_prompt", message: "rejected" },
        },
      },
    ],
    canonical: expected("resp_failed", [], [], { error: "invalid_prompt: rejected" }),
  },
];

describe("Responses stream processor parity fixtures", () => {
  it.each(fixtures)("$name", async (fixture) => {
    expect(await runFixture(fixture.events)).toEqual(fixture.canonical);
  });
});

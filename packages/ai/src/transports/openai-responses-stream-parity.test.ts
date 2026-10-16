import { describe, expect, it } from "vitest";
import {
  completed,
  runFixture,
  type ParityFixture,
} from "./openai-responses-stream-parity.test-helpers.js";

function outputItem(event: "added" | "done", item: Record<string, unknown>, index?: number) {
  return {
    type: `response.output_item.${event}`,
    ...(index === undefined ? {} : { output_index: index }),
    item,
  };
}
function message(id: string, text: string, phase?: "commentary" | "final_answer") {
  return {
    id,
    type: "message",
    role: "assistant",
    status: "completed",
    ...(phase ? { phase } : {}),
    content: [{ type: "output_text", text, annotations: [] }],
  };
}
function startedMessage(id: string, phase?: "final_answer") {
  return {
    id,
    type: "message",
    role: "assistant",
    status: "in_progress",
    ...(phase ? { phase } : {}),
    content: [],
  };
}

function reasoning(id: string, text?: string, encrypted_content?: string) {
  return {
    id,
    type: "reasoning",
    summary: text === undefined ? [] : [{ type: "summary_text", text }],
    content: [],
    ...(encrypted_content === undefined ? {} : { encrypted_content }),
  };
}
function tool(
  id: string,
  call_id: string,
  name: string,
  args: string,
  status?: "completed" | "incomplete" | "in_progress",
) {
  return {
    id,
    call_id,
    type: "function_call",
    name,
    arguments: args,
    ...(status === undefined ? {} : { status }),
  };
}
function toolCall(
  id: string,
  name: string,
  args: unknown,
): ParityFixture["canonical"]["content"][number] {
  return { type: "toolCall", id, name, arguments: args, partialJson: false };
}

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
    canonical: {
      events: [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_start", contentIndex: 1 },
        { type: "thinking_delta", contentIndex: 0, delta: "A" },
        { type: "thinking_delta", contentIndex: 1, delta: "B" },
        { type: "thinking_end", contentIndex: 1, content: "B" },
        { type: "thinking_end", contentIndex: 0, content: "A" },
      ],
      content: [
        { type: "thinking", thinking: "A", encrypted: false },
        { type: "thinking", thinking: "B", encrypted: false },
      ],
      responseId: "resp_interleaved",
      stopReason: "stop",
      error: null,
    },
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
    canonical: {
      events: [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_delta", contentIndex: 0, delta: "summary" },
        { type: "thinking_delta", contentIndex: 0, delta: "\n\n" },
        { type: "thinking_end", contentIndex: 0, content: "summary" },
      ],
      content: [{ type: "thinking", thinking: "summary", encrypted: false }],
      responseId: "resp_summary",
      stopReason: "stop",
      error: null,
    },
  },
  {
    name: "stream close without terminal response",
    events: [outputItem("done", message("msg_early", "early"), 0)],
    canonical: {
      events: [
        { type: "text_start", contentIndex: 0 },
        { type: "text_end", contentIndex: 0, content: "early" },
      ],
      content: [{ type: "text", text: "early" }],
      responseId: null,
      stopReason: "stop",
      error: "OpenAI Responses stream ended before a terminal response event",
    },
  },
  {
    name: "terminal encrypted reasoning backfill",
    events: [
      outputItem("added", reasoning("rs_backfill"), 0),
      outputItem("done", reasoning("rs_backfill", "thought"), 0),
      completed("resp_backfill", [reasoning("rs_backfill", "thought", "encrypted")]),
    ],
    canonical: {
      events: [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_end", contentIndex: 0, content: "thought" },
      ],
      content: [{ type: "thinking", thinking: "thought", encrypted: true }],
      responseId: "resp_backfill",
      stopReason: "stop",
      error: null,
    },
  },
  {
    name: "null completed message content preserves streamed text",
    events: [
      outputItem("added", startedMessage("msg_null"), 0),
      {
        type: "response.content_part.added",
        output_index: 0,
        item_id: "msg_null",
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        item_id: "msg_null",
        content_index: 0,
        delta: "kept",
      },
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
    canonical: {
      events: [
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "kept" },
        { type: "text_end", contentIndex: 0, content: "kept" },
      ],
      content: [{ type: "text", text: "kept" }],
      responseId: "resp_null",
      stopReason: "stop",
      error: null,
    },
  },
  {
    name: "finalized tool call drops streaming scratch",
    events: [
      outputItem("added", tool("fc_scratch", "call_scratch", "lookup", "", "in_progress"), 0),
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "fc_scratch",
        delta: '{"q":"x"}',
      },
      outputItem("done", tool("fc_scratch", "call_scratch", "lookup", '{"q":"x"}', "completed"), 0),
      completed("resp_scratch"),
    ],
    canonical: {
      events: [
        { type: "toolcall_start", contentIndex: 0 },
        { type: "toolcall_delta", contentIndex: 0, delta: '{"q":"x"}' },
        { type: "toolcall_end", contentIndex: 0 },
      ],
      content: [toolCall("call_scratch|fc_scratch", "lookup", { q: "x" })],
      responseId: "resp_scratch",
      stopReason: "toolUse",
      error: null,
    },
  },
  {
    name: "reused indexed output slot fails closed",
    events: [
      outputItem("added", reasoning("rs_first"), 0),
      outputItem("added", reasoning("rs_second"), 0),
      completed("resp_reused"),
    ],
    canonical: {
      events: [{ type: "thinking_start", contentIndex: 0 }],
      content: [
        { type: "thinking", thinking: "", encrypted: false },
        { type: "thinking", thinking: "", encrypted: false },
      ],
      responseId: null,
      stopReason: "stop",
      error: "Responses stream reused active output index 0",
    },
  },
  {
    name: "deferred text materializes before an unindexed tool boundary",
    events: [
      outputItem("done", message("msg_before_tool", "Hello")),
      outputItem("added", startedMessage("msg_after_tool")),
      { type: "response.output_text.delta", item_id: "msg_after_tool", delta: "Hello again" },
      outputItem("done", tool("fc_boundary", "call_boundary", "lookup", "{}", "completed")),
      outputItem("done", message("msg_after_tool", "Hello again")),
      completed("resp_tool_boundary"),
    ],
    canonical: {
      events: [
        { type: "text_start", contentIndex: 0 },
        { type: "text_end", contentIndex: 0, content: "Hello" },
        { type: "text_start", contentIndex: 1 },
        { type: "text_delta", contentIndex: 1, delta: "Hello again" },
        { type: "toolcall_start", contentIndex: 2 },
        { type: "toolcall_end", contentIndex: 2 },
        { type: "text_end", contentIndex: 1, content: "Hello again" },
      ],
      content: [
        { type: "text", text: "Hello" },
        { type: "text", text: "Hello again" },
        toolCall("call_boundary|fc_boundary", "lookup", {}),
      ],
      responseId: "resp_tool_boundary",
      stopReason: "toolUse",
      error: null,
    },
  },
  {
    name: "normal output text lifecycle",
    events: [
      outputItem("added", startedMessage("msg_text"), 0),
      {
        type: "response.content_part.added",
        output_index: 0,
        item_id: "msg_text",
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        item_id: "msg_text",
        content_index: 0,
        delta: "hello",
      },
      outputItem("done", message("msg_text", "hello"), 0),
      completed("resp_text", [message("msg_text", "hello")]),
    ],
    canonical: {
      events: [
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "hello" },
        { type: "text_end", contentIndex: 0, content: "hello" },
      ],
      content: [{ type: "text", text: "hello" }],
      responseId: "resp_text",
      stopReason: "stop",
      error: null,
    },
  },
  {
    name: "terminal-only completed message recovery",
    events: [completed("resp_terminal_text", [message("msg_terminal", "recovered")])],
    canonical: {
      events: [
        { type: "text_start", contentIndex: 0 },
        { type: "text_end", contentIndex: 0, content: "recovered" },
      ],
      content: [{ type: "text", text: "recovered" }],
      responseId: "resp_terminal_text",
      stopReason: "stop",
      error: null,
    },
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
    canonical: {
      events: [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_end", contentIndex: 0, content: "first thought" },
        { type: "thinking_start", contentIndex: 1 },
        { type: "thinking_end", contentIndex: 1, content: "second thought" },
        { type: "text_start", contentIndex: 2 },
        { type: "text_end", contentIndex: 2, content: "recovered final answer" },
      ],
      content: [
        { type: "thinking", thinking: "first thought", encrypted: false },
        { type: "thinking", thinking: "second thought", encrypted: false },
        { type: "text", text: "recovered final answer" },
      ],
      responseId: "resp_multi_reasoning_terminal_text",
      stopReason: "stop",
      error: null,
    },
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
    canonical: {
      events: [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_end", contentIndex: 0, content: "thought" },
        { type: "text_start", contentIndex: 1 },
        { type: "text_end", contentIndex: 1, content: "I cannot help with that." },
      ],
      content: [
        { type: "thinking", thinking: "thought", encrypted: false },
        { type: "text", text: "I cannot help with that." },
      ],
      responseId: "resp_reasoning_terminal_refusal",
      stopReason: "stop",
      error: null,
    },
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
    canonical: {
      events: [
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "I cannot" },
        { type: "text_delta", contentIndex: 0, delta: " help." },
        { type: "text_end", contentIndex: 0, content: "I cannot help." },
      ],
      content: [{ type: "text", text: "I cannot help." }],
      responseId: "resp_refusal",
      stopReason: "stop",
      error: null,
    },
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
    canonical: {
      events: [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_end", contentIndex: 0, content: "thought" },
      ],
      content: [{ type: "thinking", thinking: "thought", encrypted: false }],
      responseId: "resp_reasoning_terminal_null",
      stopReason: "stop",
      error: null,
    },
  },
  {
    name: "terminal-only completed tool call recovery after streamed reasoning",
    events: [
      outputItem("added", reasoning("rs_before_tool"), 0),
      outputItem("done", reasoning("rs_before_tool", "thought"), 0),
      completed("resp_reasoning_terminal_tool", [
        reasoning("rs_before_tool", "thought"),
        tool("fc_terminal", "call_terminal", "lookup", '{"q":"x"}', "completed"),
      ]),
    ],
    canonical: {
      events: [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_end", contentIndex: 0, content: "thought" },
        { type: "toolcall_start", contentIndex: 1 },
        { type: "toolcall_end", contentIndex: 1 },
      ],
      content: [
        { type: "thinking", thinking: "thought", encrypted: false },
        toolCall("call_terminal|fc_terminal", "lookup", { q: "x" }),
      ],
      responseId: "resp_reasoning_terminal_tool",
      stopReason: "toolUse",
      error: null,
    },
  },
  {
    name: "output text delta without content part",
    events: [
      outputItem("added", startedMessage("msg_no_part"), 0),
      {
        type: "response.output_text.delta",
        output_index: 0,
        item_id: "msg_no_part",
        content_index: 0,
        delta: "compatible",
      },
      outputItem("done", message("msg_no_part", "compatible"), 0),
      completed("resp_no_part"),
    ],
    canonical: {
      events: [
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "compatible" },
        { type: "text_end", contentIndex: 0, content: "compatible" },
      ],
      content: [{ type: "text", text: "compatible" }],
      responseId: "resp_no_part",
      stopReason: "stop",
      error: null,
    },
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
    canonical: {
      events: [],
      content: [],
      responseId: "resp_failed",
      stopReason: "stop",
      error: "invalid_prompt: rejected",
    },
  },
];

describe("Responses stream processor parity fixtures", () => {
  it.each(fixtures)("$name", async (fixture) => {
    expect(await runFixture(fixture.events)).toEqual(fixture.canonical);
  });
});

import { createHook } from "node:async_hooks";
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

const fixtures: ParityFixture[] = [
  parityFixture(
    "indexed interleaved reasoning items",
    [
      outputItem("added", reasoning("rs_0"), 0),
      outputItem("added", reasoning("rs_1"), 1),
      { type: "response.reasoning_text.delta", output_index: 0, item_id: "rs_0", delta: "A" },
      { type: "response.reasoning_text.delta", output_index: 1, item_id: "rs_1", delta: "B" },
      outputItem("done", reasoning("rs_1"), 1),
      outputItem("done", reasoning("rs_0"), 0),
      completed("resp"),
    ],
    [
      blockEvent("thinking_start"),
      blockEvent("thinking_start", 1),
      blockEvent("thinking_delta", 0, "A"),
      blockEvent("thinking_delta", 1, "B"),
      blockEvent("thinking_end", 1, "B"),
      blockEvent("thinking_end", 0, "A"),
    ],
    [thinkingBlock("A"), thinkingBlock("B")],
  ),
  parityFixture(
    "reasoning summary text and part completion preserve delta order",
    [
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
      completed("resp"),
    ],
    thinkingEvents("summary", 0, ["summary", "\n\n"]),
    [thinkingBlock("summary")],
  ),
  parityFixture(
    "stream close without terminal response",
    [outputItem("done", message("msg_early", "early"), 0)],
    textEvents("early"),
    [textBlock("early")],
    { responseId: null, error: "OpenAI Responses stream ended before a terminal response event" },
  ),
  parityFixture(
    "terminal encrypted reasoning backfill",
    [
      outputItem("added", reasoning("rs_backfill"), 0),
      outputItem("done", reasoning("rs_backfill", "thought"), 0),
      completed("resp", [reasoning("rs_backfill", "thought", "encrypted")]),
    ],
    thinkingEvents("thought"),
    [thinkingBlock("thought", true)],
  ),
  parityFixture(
    "null completed message content preserves streamed text",
    [
      outputItem("added", startedMessage("msg_null"), 0),
      outputTextPart("msg_null"),
      outputTextDelta("msg_null", "kept"),
      outputItem("done", { ...message("msg_null", ""), content: null }, 0),
      completed("resp"),
    ],
    textEvents("kept", 0, ["kept"]),
    [textBlock("kept")],
  ),
  parityFixture(
    "finalized tool call drops streaming scratch",
    [
      outputItem("added", tool("scratch", "", "in_progress"), 0),
      argumentDelta("fc_scratch", '{"q":"x"}'),
      outputItem("done", tool("scratch", '{"q":"x"}', "completed"), 0),
      completed("resp"),
    ],
    [
      blockEvent("toolcall_start"),
      { type: "toolcall_delta", contentIndex: 0, delta: '{"q":"x"}' },
      blockEvent("toolcall_end"),
    ],
    [toolCall("call_scratch|fc_scratch", "lookup", { q: "x" })],
    { stopReason: "toolUse" },
  ),
  parityFixture(
    "reused indexed output slot fails closed",
    [
      outputItem("added", reasoning("rs_first"), 0),
      outputItem("added", reasoning("rs_second"), 0),
      completed("resp"),
    ],
    [blockEvent("thinking_start")],
    [thinkingBlock(""), thinkingBlock("")],
    { responseId: null, error: "Responses stream reused active output index 0" },
  ),
  parityFixture(
    "deferred text materializes before an unindexed tool boundary",
    [
      outputItem("done", message("msg_before_tool", "Hello")),
      outputItem("added", startedMessage("msg_after_tool")),
      { type: "response.output_text.delta", item_id: "msg_after_tool", delta: "Hello again" },
      outputItem("done", tool("boundary", "{}", "completed")),
      outputItem("done", message("msg_after_tool", "Hello again")),
      completed("resp"),
    ],
    [
      ...textEvents("Hello"),
      blockEvent("text_start", 1),
      blockEvent("text_delta", 1, "Hello again"),
      blockEvent("toolcall_start", 2),
      blockEvent("toolcall_end", 2),
      blockEvent("text_end", 1, "Hello again"),
    ],
    [
      textBlock("Hello"),
      textBlock("Hello again"),
      toolCall("call_boundary|fc_boundary", "lookup", {}),
    ],
    { stopReason: "toolUse" },
  ),
  parityFixture(
    "normal output text lifecycle",
    [
      outputItem("added", startedMessage("msg_text"), 0),
      outputTextPart("msg_text"),
      outputTextDelta("msg_text", "hello"),
      outputItem("done", message("msg_text", "hello"), 0),
      completed("resp", [message("msg_text", "hello")]),
    ],
    textEvents("hello", 0, ["hello"]),
    [textBlock("hello")],
  ),
  parityFixture(
    "terminal-only completed message recovery",
    [completed("resp", [message("msg_terminal", "recovered")])],
    textEvents("recovered"),
    [textBlock("recovered")],
  ),
  parityFixture(
    "terminal completed message recovery after multiple streamed reasoning blocks",
    [
      outputItem("added", reasoning("rs_before_multi_first"), 0),
      outputItem("done", reasoning("rs_before_multi_first", "first thought"), 0),
      outputItem("added", reasoning("rs_before_multi_second"), 1),
      outputItem("done", reasoning("rs_before_multi_second", "second thought"), 1),
      completed("resp", [
        reasoning("rs_before_multi_first", "first thought"),
        reasoning("rs_before_multi_second", "second thought"),
        message("msg_after_multiple_reasoning", "recovered final answer", "final_answer"),
      ]),
    ],
    [
      ...thinkingEvents("first thought"),
      ...thinkingEvents("second thought", 1),
      ...textEvents("recovered final answer", 2),
    ],
    [
      thinkingBlock("first thought"),
      thinkingBlock("second thought"),
      textBlock("recovered final answer"),
    ],
  ),
  parityFixture(
    "terminal completed refusal recovery after streamed reasoning",
    [
      outputItem("added", reasoning("rs_before_refusal"), 0),
      outputItem("done", reasoning("rs_before_refusal", "thought"), 0),
      completed("resp", [
        reasoning("rs_before_refusal", "thought"),
        {
          ...message("msg_after_reasoning_refusal", ""),
          content: [{ type: "refusal", refusal: "I cannot help with that." }],
        },
      ]),
    ],
    [...thinkingEvents("thought"), ...textEvents("I cannot help with that.", 1)],
    [thinkingBlock("thought"), textBlock("I cannot help with that.")],
  ),
  parityFixture(
    "streamed refusal uses the text delta lifecycle",
    [
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
          ...message("msg_refusal", ""),
          content: [{ type: "refusal", refusal: "I cannot help." }],
        },
        0,
      ),
      completed("resp"),
    ],
    textEvents("I cannot help.", 0, ["I cannot", " help."]),
    [textBlock("I cannot help.")],
  ),
  parityFixture(
    "terminal null message after streamed reasoning is ignored",
    [
      outputItem("added", reasoning("rs_terminal_null"), 0),
      outputItem("done", reasoning("rs_terminal_null", "thought"), 0),
      completed("resp", [
        reasoning("rs_terminal_null", "thought"),
        { ...message("msg_after_reasoning_null", ""), content: null },
      ]),
    ],
    thinkingEvents("thought"),
    [thinkingBlock("thought")],
  ),
  parityFixture(
    "terminal-only completed tool call recovery after streamed reasoning",
    [
      outputItem("added", reasoning("rs_before_tool"), 0),
      outputItem("done", reasoning("rs_before_tool", "thought"), 0),
      completed("resp", [
        reasoning("rs_before_tool", "thought"),
        tool("terminal", '{"q":"x"}', "completed"),
      ]),
    ],
    [...thinkingEvents("thought"), blockEvent("toolcall_start", 1), blockEvent("toolcall_end", 1)],
    [thinkingBlock("thought"), toolCall("call_terminal|fc_terminal", "lookup", { q: "x" })],
    { stopReason: "toolUse" },
  ),
  parityFixture(
    "output text delta without content part",
    [
      outputItem("added", startedMessage("msg_no_part"), 0),
      outputTextDelta("msg_no_part", "compatible"),
      outputItem("done", message("msg_no_part", "compatible"), 0),
      completed("resp"),
    ],
    textEvents("compatible", 0, ["compatible"]),
    [textBlock("compatible")],
  ),
  parityFixture(
    "detailed response failure is terminal",
    [
      {
        type: "response.failed",
        sequence_number: 1,
        response: {
          id: "resp",
          status: "failed",
          error: { code: "invalid_prompt", message: "rejected" },
        },
      },
    ],
    [],
    [],
    { error: "invalid_prompt: rejected" },
  ),
];

describe("Responses stream processor parity fixtures", () => {
  // Bun does not emit async_hooks PROMISE events; this budget measures Node/V8.
  it.skipIf(Boolean(process.versions.bun))(
    "keeps bookkeeping events within the stream promise budget",
    async () => {
      const count = 1_000;
      const events = Array.from({ length: count }, () => ({
        type: "response.in_progress",
        response: { id: "resp" },
      }));
      let promises = 0;
      const hook = createHook({
        init(_id, type) {
          if (type === "PROMISE") {
            promises++;
          }
        },
      });
      hook.enable();
      try {
        const result = await runFixture([...events, completed("resp")]);
        expect(result.error).toBeNull();
        expect(result.responseId).toBe("resp");
        // Includes the fixture source and cooperative scheduling. A redundant
        // adaptation iterator adds four promises per event (about 13,000 total).
        expect(promises).toBeGreaterThan(count);
        expect(promises).toBeLessThan(count * 11);
      } finally {
        hook.disable();
      }
    },
  );

  it.each(fixtures)("$name", async (fixture) => {
    expect(await runFixture(fixture.events)).toEqual(fixture.canonical);
  });
});

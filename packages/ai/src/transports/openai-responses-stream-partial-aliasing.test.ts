import { describe, expect, it } from "vitest";
import { createResponsesAssistantOutput } from "../providers/openai-responses-shared.js";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { processResponsesStream } from "./openai-responses-stream-internal.js";
import { expectReplaceAppendText, type TextOrDelta } from "./openai-stream-cases.test-support.js";

// Regression for the responses-stream partial-snapshot aliasing defect
// (observed in production 2026-10-14 as doubled first deltas on assistant
// messages): boundary events used to carry `partial` as a reference to the
// transport's LIVE AssistantMessage, and text deltas mutate their block in
// place before the delta event is pushed. A consumer that replaces its state
// with `event.partial` (agent-core's replace-or-append contract) therefore
// held an object that already contained the next delta, and appending the
// delta event doubled it. The doubling was transient on screen and healed by
// the final snapshot, so only first deltas long enough to trip downstream
// guards left a visible trace. The fix detaches `partial` at the transport's
// single event choke point; these tests pin the consumer-visible contract.

const model = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

const WIRE_TEXT = "夜班巡检记录：雾笛、备用灯与无线电均正常。";

function reasoningThenMessageEvents(firstDelta: string, secondDelta: string): unknown[] {
  return [
    { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", id: "rs_1", status: "in_progress" },
    },
    { type: "response.reasoning_summary_part.added", part: { type: "summary_text", text: "" } },
    { type: "response.reasoning_summary_text.delta", delta: "Considering the answer." },
    { type: "response.reasoning_summary_text.done", text: "Considering the answer." },
    {
      type: "response.reasoning_summary_part.done",
      part: { type: "summary_text", text: "Considering the answer." },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "reasoning", id: "rs_1", status: "completed" },
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "message", id: "msg_1", status: "in_progress" },
    },
    {
      type: "response.content_part.added",
      item_id: "msg_1",
      content_index: 0,
      part: { type: "output_text", text: "" },
    },
    { type: "response.output_text.delta", item_id: "msg_1", content_index: 0, delta: firstDelta },
    { type: "response.output_text.delta", item_id: "msg_1", content_index: 0, delta: secondDelta },
    {
      type: "response.output_text.done",
      item_id: "msg_1",
      content_index: 0,
      text: `${firstDelta}${secondDelta}`,
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: {
        type: "message",
        id: "msg_1",
        status: "completed",
        content: [{ type: "output_text", text: `${firstDelta}${secondDelta}` }],
      },
    },
    { type: "response.completed", response: { id: "resp_1", status: "completed" } },
  ];
}

async function* sourceOf(events: readonly unknown[]) {
  for (const event of events) {
    yield event;
  }
}

describe("Responses stream partial snapshots", () => {
  it("consumer replace/append state stays byte-exact with the wire text", async () => {
    const run = async (firstDelta: string) => {
      const output: AssistantMessage = { ...createResponsesAssistantOutput(model), timestamp: 0 };
      const stream = new AssistantMessageEventStream();
      const emitted: AssistantMessageEvent[] = [];
      const collect = (async () => {
        for await (const event of stream) {
          emitted.push(event);
        }
      })();
      await processResponsesStream(
        sourceOf(reasoningThenMessageEvents(firstDelta, WIRE_TEXT.slice(firstDelta.length))),
        output,
        stream,
        model,
      );
      stream.end();
      await collect;
      return { emitted, output };
    };

    for (const firstDelta of [WIRE_TEXT.slice(0, 9), WIRE_TEXT.slice(0, 2)]) {
      const { emitted, output } = await run(firstDelta);
      expectReplaceAppendText(emitted, WIRE_TEXT);
      const transportText = output.content
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("");
      expect(transportText).toBe(WIRE_TEXT);
      // Snapshot contract: text blocks are detached (never the transport's
      // live objects); thinking blocks stay referenced so their mutation
      // owner's WeakMap append facts (#123120) keep working.
      const liveBlocks = new Set(output.content);
      let sawText = false;
      let sawThinking = false;
      for (const event of emitted) {
        const partial = (event as TextOrDelta).partial;
        if (!partial) {
          continue;
        }
        for (const block of partial.content) {
          if (block.type === "text") {
            expect(liveBlocks.has(block)).toBe(false);
            sawText = true;
          } else if (block.type === "thinking") {
            expect(liveBlocks.has(block)).toBe(true);
            sawThinking = true;
          }
        }
      }
      expect(sawText).toBe(true);
      expect(sawThinking).toBe(true);
    }
  });
});

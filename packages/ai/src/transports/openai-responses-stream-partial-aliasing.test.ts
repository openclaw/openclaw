import { describe, expect, it } from "vitest";
import { createResponsesAssistantOutput } from "../providers/openai-responses-shared.js";
import { makeProviderModel } from "../providers/provider-model.test-support.js";
import type { AssistantMessageEvent } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { processResponsesStream } from "./openai-responses-stream-internal.js";
import {
  expectReplaceAppendText,
  outputItem,
  type TextOrDelta,
} from "./openai-stream-cases.test-support.js";

// #172653: live partials doubled the next delta in replace/append consumers;
// final snapshots healed it, so intermediate prefixes must be checked too.
const model = makeProviderModel("openai-responses", "openai", "gpt-5.5", {
  baseUrl: "https://api.openai.com/v1",
});

const WIRE_TEXT = "夜班巡检记录：雾笛、备用灯与无线电均正常。";

function reasoningThenMessageEvents(firstDelta: string, secondDelta: string): unknown[] {
  const textEvent = (phase: "delta" | "done", text: string) => ({
    type: `response.output_text.${phase}`,
    item_id: "msg_1",
    content_index: 0,
    [phase === "delta" ? "delta" : "text"]: text,
  });
  const summary = { type: "summary_text", text: "Considering the answer." };
  return [
    { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
    outputItem("added", { type: "reasoning", id: "rs_1", status: "in_progress" }),
    { type: "response.reasoning_summary_part.added", part: { type: "summary_text", text: "" } },
    { type: "response.reasoning_summary_text.delta", delta: "Considering the answer." },
    { type: "response.reasoning_summary_text.done", text: "Considering the answer." },
    { type: "response.reasoning_summary_part.done", part: summary },
    outputItem("done", { type: "reasoning", id: "rs_1", status: "completed" }),
    outputItem("added", { type: "message", id: "msg_1", status: "in_progress" }, 1),
    {
      type: "response.content_part.added",
      item_id: "msg_1",
      content_index: 0,
      part: { type: "output_text", text: "" },
    },
    textEvent("delta", firstDelta),
    textEvent("delta", secondDelta),
    textEvent("done", `${firstDelta}${secondDelta}`),
    outputItem(
      "done",
      {
        type: "message",
        id: "msg_1",
        status: "completed",
        content: [{ type: "output_text", text: `${firstDelta}${secondDelta}` }],
      },
      1,
    ),
    { type: "response.completed", response: { id: "resp_1", status: "completed" } },
  ];
}

async function* sourceOf(events: readonly unknown[]) {
  yield* events;
}

describe("Responses stream partial snapshots", () => {
  it("consumer replace/append state stays byte-exact with the wire text", async () => {
    for (const firstDelta of [WIRE_TEXT.slice(0, 9), WIRE_TEXT.slice(0, 2)]) {
      const output = { ...createResponsesAssistantOutput(model), timestamp: 0 };
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
      expectReplaceAppendText(emitted, WIRE_TEXT);
      const transportText = output.content
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("");
      expect(transportText).toBe(WIRE_TEXT);
      // Text detaches; thinking retains WeakMap append facts (#123120).
      const liveBlocks = new Set(output.content);
      const partialBlocks = emitted.flatMap(
        (event) => (event as TextOrDelta).partial?.content ?? [],
      );
      for (const type of ["text", "thinking"]) {
        const blocks = partialBlocks.filter((block) => block.type === type);
        expect(blocks.length).toBeGreaterThan(0);
        for (const block of blocks) {
          expect(liveBlocks.has(block)).toBe(type === "thinking");
        }
      }
    }
  });
});

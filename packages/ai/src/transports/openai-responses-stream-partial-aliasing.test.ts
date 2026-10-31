import { expect, it, vi } from "vitest";
import { collect } from "../../../../test/helpers/async-iterable.js";
import { createResponsesAssistantOutput } from "../providers/openai-responses-shared.js";
import { makeProviderModel } from "../providers/provider-model.test-support.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { onLlmRequestActivity } from "../utils/llm-request-activity.js";
import { processResponsesStream } from "./openai-responses-stream-internal.js";
import {
  expectReplaceAppendText,
  completedResponse,
  outputItem,
  wireMessage,
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
    outputItem("done", wireMessage("msg_1", `${firstDelta}${secondDelta}`), 1),
    { type: "response.completed", response: { id: "resp_1", status: "completed" } },
  ];
}

async function* sourceOf(events: readonly unknown[]) {
  yield* events;
}

async function runResponses(
  events: readonly unknown[],
  options?: Parameters<typeof processResponsesStream>[4],
) {
  const output = { ...createResponsesAssistantOutput(model), timestamp: 0 };
  const stream = new AssistantMessageEventStream();
  const collected = collect(stream);
  await processResponsesStream(sourceOf(events), output, stream, model, options);
  stream.end();
  return { output, emitted: await collected };
}

it("consumer replace/append state stays byte-exact with the wire text", async () => {
  for (const firstDelta of [WIRE_TEXT.slice(0, 9), WIRE_TEXT.slice(0, 2)]) {
    const { output, emitted } = await runResponses(
      reasoningThenMessageEvents(firstDelta, WIRE_TEXT.slice(firstDelta.length)),
    );
    expectReplaceAppendText(emitted, WIRE_TEXT);
    const transportText = output.content
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("");
    expect(transportText).toBe(WIRE_TEXT);
    // Text detaches; thinking retains WeakMap append facts (#123120).
    const liveBlocks = new Set(output.content);
    const partialBlocks = emitted.flatMap((event) => (event as TextOrDelta).partial?.content ?? []);
    for (const type of ["text", "thinking"]) {
      const blocks = partialBlocks.filter((block) => block.type === type);
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(liveBlocks.has(block)).toBe(type === "thinking");
      }
    }
  }
});

it("distinguishes physical activity from output advancement and repeated snapshots", async () => {
  const controller = new AbortController();
  const onActivity = vi.fn();
  const unsubscribe = onLlmRequestActivity(controller.signal, onActivity);
  try {
    const snapshot = outputItem("done", {
      id: "reasoning_activity",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Synthetic snapshot" }],
    });
    const hosted = { id: "hosted_activity", type: "web_search_call", status: "completed" };
    const events = [
      { type: "response.created", response: { id: "resp_activity" } },
      { type: "response.in_progress", response: { id: "resp_activity" } },
      outputItem("added", { id: "reasoning_activity", type: "reasoning", summary: [] }),
      {
        type: "response.reasoning_text.delta",
        output_index: 0,
        delta: "Synthetic hidden progress",
      },
      { type: "response.reasoning_text.delta", output_index: 0, delta: "" },
      structuredClone(snapshot),
      structuredClone(snapshot),
      // Hosted lifecycle echoes are physical activity, not new model output.
      ...(["added", "done", "done"] as const).map((phase) => outputItem(phase, { ...hosted }, 1)),
      completedResponse("resp_activity", []),
    ];
    await runResponses(events, { signal: controller.signal });
    expect(onActivity.mock.calls).toEqual(
      [false, false, true, true, false, true, false, false, false, false, true].map((progress) => [
        progress,
        900_000,
      ]),
    );
  } finally {
    unsubscribe();
  }
});

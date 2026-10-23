import { describe, expect, it } from "vitest";
import type { AssistantMessage, AssistantMessageEvent, Model, TextContent } from "../types.js";
import { processCompletionsStream } from "./openai-completions-stream.js";
import {
  createAssistantOutput,
  makeCompletionsChunk,
  makeCompletionsModel,
  streamChunks,
} from "./openai-completions.test-support.js";

// Regression for the completions-stream half of the partial-snapshot aliasing
// defect (sibling of openai-responses-stream-partial-aliasing.test.ts):
// `text_start` carries `partial: output` — the transport's live
// AssistantMessage — and content deltas mutate `currentBlock.text` in place
// before the delta event is pushed. A consumer that replaces state with
// event.partial then appends the delta double-applies it. Mirror of the
// production capture regression on the responses route.

const model: Model<"openai-completions"> = makeCompletionsModel({
  provider: "volcengine-plan",
  id: "deepseek-v4-flash",
  baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
});

const FIRST = "夜班巡检记录：雾笛、";
const SECOND = "备用灯与无线电均正常。";
const WIRE_TEXT = `${FIRST}${SECOND}`;

type TextOrDelta = AssistantMessageEvent & {
  partial?: AssistantMessage;
  contentIndex?: number;
  delta?: string;
};

function consumeLikeAgentCore(events: readonly AssistantMessageEvent[]): {
  text: string;
  prevBeforeAppend: string[];
} {
  let state: AssistantMessage | null = null;
  const prevBeforeAppend: string[] = [];
  for (const event of events) {
    const typed = event as TextOrDelta;
    if (typed.partial) {
      state = typed.partial;
      continue;
    }
    if (event.type === "text_delta") {
      const content = [...(state?.content ?? [])];
      const idx = typed.contentIndex ?? 0;
      const current = content[idx] as TextContent | undefined;
      const prev = current?.type === "text" ? current.text : "";
      prevBeforeAppend.push(prev);
      content[idx] =
        current?.type === "text"
          ? { ...current, text: prev + (typed.delta ?? "") }
          : { type: "text", text: typed.delta ?? "" };
      state = { ...(state ?? { content: [] }), content } as AssistantMessage;
    }
  }
  const text = (state?.content ?? [])
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
  return { text, prevBeforeAppend };
}

describe("openai completions stream partial snapshots", () => {
  it("consumer replace/append state stays byte-exact with the wire text", async () => {
    const output = createAssistantOutput(model);
    const events: AssistantMessageEvent[] = [];
    await processCompletionsStream(
      streamChunks([
        makeCompletionsChunk({ content: FIRST }, undefined),
        makeCompletionsChunk({ content: SECOND }, "stop"),
      ]),
      output,
      model,
      { push: (event) => events.push(event) },
    );

    const consumer = consumeLikeAgentCore(events);
    // Intermediate checkpoints: before each append, the consumer state must
    // equal exactly the wire text emitted so far — a delta already sitting in
    // an aliased block surfaces here as a doubled prefix.
    const deltas = events
      .filter((event): event is typeof event & { delta: string } => event.type === "text_delta")
      .map((event) => event.delta);
    expect(consumer.prevBeforeAppend).toHaveLength(deltas.length);
    let accumulated = "";
    for (const [index, prev] of consumer.prevBeforeAppend.entries()) {
      expect(prev).toBe(accumulated);
      accumulated += deltas[index];
    }
    expect(accumulated).toBe(WIRE_TEXT);
    expect(consumer.text).toBe(WIRE_TEXT);
    // Snapshot contract: text blocks are detached (never the transport's
    // live objects).
    const liveBlocks = new Set(output.content);
    let sawText = false;
    for (const event of events) {
      const partial = (event as TextOrDelta).partial;
      if (!partial) {
        continue;
      }
      for (const block of partial.content) {
        if (block.type === "text") {
          expect(liveBlocks.has(block)).toBe(false);
          sawText = true;
        }
      }
    }
    expect(sawText).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import type { AssistantMessageEvent, Model } from "../types.js";
import { processCompletionsStream } from "./openai-completions-stream.js";
import {
  createAssistantOutput,
  makeCompletionsChunk,
  makeCompletionsModel,
  streamChunks,
} from "./openai-completions.test-support.js";
import { expectReplaceAppendText, type TextOrDelta } from "./openai-stream-cases.test-support.js";

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

    expectReplaceAppendText(events, WIRE_TEXT);
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

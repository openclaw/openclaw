import { describe, expect, it } from "vitest";
import { processCompletionsStream } from "./openai-completions-stream.js";
import {
  createAssistantOutput,
  makeCompletionsChunk,
  makeCompletionsModel,
} from "./openai-completions.test-support.js";

describe("reasoning-first completions", () => {
  it.each(["reasoning", "reasoning_content"] as const)(
    "streams visible text after %s before reading another chunk",
    async (field) => {
      const model = makeCompletionsModel();
      for (const sameChunk of [false, true]) {
        for (const emitReasoning of [false, true]) {
          const output = createAssistantOutput(model);
          const text: string[] = [];
          async function* chunks() {
            yield makeCompletionsChunk({ [field]: "Think." });
            yield makeCompletionsChunk({
              ...(sameChunk ? { [field]: " Done." } : {}),
              content: "Answer",
            });
            expect(text.join("")).toBe("Answer");
            yield makeCompletionsChunk({ content: " continues." });
            expect(text.join("")).toBe("Answer continues.");
            yield makeCompletionsChunk({ [field]: "Reconsider." });
            yield makeCompletionsChunk({ content: "Final." });
            expect(text.join("")).toBe("Answer continues.Final.");
            yield makeCompletionsChunk({}, "stop");
          }
          await processCompletionsStream(
            chunks(),
            output,
            model,
            {
              push(event) {
                if (event.type === "text_delta") {
                  text.push(event.delta);
                }
              },
            },
            { emitReasoning },
          );
          expect(output.stopReason).toBe("stop");
          expect(output.content.filter((block) => block.type === "text")).toEqual([
            { type: "text", text: "Answer continues." },
            { type: "text", text: "Final." },
          ]);
        }
      }
    },
  );

  it("streams structured text after buffered markdown before reading another chunk", async () => {
    const model = makeCompletionsModel();
    const output = createAssistantOutput(model);
    const text: string[] = [];
    async function* chunks() {
      // The trailing "<" stays held as possible tag syntax, so the reasoning
      // transition below runs with pending buffered text.
      yield makeCompletionsChunk({ content: "Knock knock. <" });
      yield makeCompletionsChunk({
        content: [
          { type: "thinking", thinking: "Reconsider." },
          { type: "text", text: "Answer" },
        ],
      });
      expect(text.join("")).toBe("Knock knock. <Answer");
      yield makeCompletionsChunk({ content: " continues." });
      expect(text.join("")).toBe("Knock knock. <Answer continues.");
      yield makeCompletionsChunk({}, "stop");
    }
    await processCompletionsStream(chunks(), output, model, {
      push(event) {
        if (event.type === "text_delta") {
          text.push(event.delta);
        }
      },
    });
    expect(output.stopReason).toBe("stop");
  });

  it.each(["", "Answer. "])("keeps unfinished reasoning private after %j", async (prefix) => {
    const model = makeCompletionsModel();
    const output = createAssistantOutput(model);
    const text: string[] = [];
    async function* chunks() {
      yield makeCompletionsChunk({ reasoning_content: "Native reasoning." });
      yield makeCompletionsChunk({ content: `${prefix}<think>unfinished reasoning` });
      yield makeCompletionsChunk({}, "stop");
    }
    await processCompletionsStream(
      chunks(),
      output,
      model,
      {
        push(event) {
          if (event.type === "text_delta") {
            text.push(event.delta);
          }
        },
      },
      { emitReasoning: false },
    );
    expect(text.join("")).toBe(prefix);
    expect(
      output.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(""),
    ).toBe(prefix);
  });
});

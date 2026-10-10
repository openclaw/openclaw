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
          expect(output.content.filter((block) => block.type === "text")).toMatchObject([
            { text: "Answer continues.", textSignature: expect.stringContaining('"commentary"') },
            { text: "Final.", textSignature: expect.stringContaining('"final_answer"') },
          ]);
        }
      }
    },
  );

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

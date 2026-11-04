// Shared OpenAI-compatible tests cover reasoning detail progress shapes.
import { describe, expect, it } from "vitest";
import { readOpenAICompletionsReasoningBatch } from "./openai-transport-shared.js";

const VISIBLE_DETAIL_TYPES = new Set(["reasoning.summary.visible"]);

describe("readOpenAICompletionsReasoningBatch", () => {
  it("counts a summary-only reasoning detail as hidden thinking progress", () => {
    const batch = readOpenAICompletionsReasoningBatch(
      {
        reasoning_details: [{ type: "reasoning.summary", summary: "Synthetic progress." }],
      },
      VISIBLE_DETAIL_TYPES,
    );

    expect(batch.hasThinking).toBe(true);
    expect(batch.mirroredThinking).toEqual(["Synthetic progress."]);
    expect(batch.deltas).toEqual([
      { kind: "thinking", signature: "reasoning_details", text: "Synthetic progress." },
    ]);
  });

  it("keeps text details as the source for other detail types", () => {
    const batch = readOpenAICompletionsReasoningBatch(
      { reasoning_details: [{ type: "reasoning.text", text: "Detail text." }] },
      VISIBLE_DETAIL_TYPES,
    );

    expect(batch.mirroredThinking).toEqual(["Detail text."]);
  });

  it("ignores empty summary and structural-only details", () => {
    const batch = readOpenAICompletionsReasoningBatch(
      {
        reasoning_details: [
          { type: "reasoning.summary", summary: "" },
          { type: "reasoning.summary" },
          { type: "reasoning.encrypted", data: "opaque" },
        ],
      },
      VISIBLE_DETAIL_TYPES,
    );

    expect(batch.hasThinking).toBe(false);
    expect(batch.deltas ?? []).toEqual([]);
  });
});

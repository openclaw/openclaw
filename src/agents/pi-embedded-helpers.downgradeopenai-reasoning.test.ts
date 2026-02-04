import { describe, expect, it } from "vitest";
import { downgradeOpenAIReasoningBlocks } from "./pi-embedded-helpers.js";

describe("downgradeOpenAIReasoningBlocks", () => {
  it("keeps reasoning signatures when followed by content", () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "internal reasoning",
            thinkingSignature: JSON.stringify({ id: "rs_123", type: "reasoning" }),
          },
          { type: "text", text: "answer" },
        ],
      },
    ];

<<<<<<< HEAD
=======
    // oxlint-disable-next-line typescript/no-explicit-any
>>>>>>> upstream/main
    expect(downgradeOpenAIReasoningBlocks(input as any)).toEqual(input);
  });

  it("drops orphaned reasoning blocks without following content", () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinkingSignature: JSON.stringify({ id: "rs_abc", type: "reasoning" }),
          },
        ],
      },
      { role: "user", content: "next" },
    ];

<<<<<<< HEAD
=======
    // oxlint-disable-next-line typescript/no-explicit-any
>>>>>>> upstream/main
    expect(downgradeOpenAIReasoningBlocks(input as any)).toEqual([
      { role: "user", content: "next" },
    ]);
  });

  it("drops object-form orphaned signatures", () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinkingSignature: { id: "rs_obj", type: "reasoning" },
          },
        ],
      },
    ];

<<<<<<< HEAD
=======
    // oxlint-disable-next-line typescript/no-explicit-any
>>>>>>> upstream/main
    expect(downgradeOpenAIReasoningBlocks(input as any)).toEqual([]);
  });

  it("keeps non-reasoning thinking signatures", () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "t",
            thinkingSignature: "reasoning_content",
          },
        ],
      },
    ];

<<<<<<< HEAD
=======
    // oxlint-disable-next-line typescript/no-explicit-any
>>>>>>> upstream/main
    expect(downgradeOpenAIReasoningBlocks(input as any)).toEqual(input);
  });
});

import { describe, expect, it } from "vitest";
import { stripReasoningReplaySignatures } from "./pi-embedded-helpers.js";

describe("stripReasoningReplaySignatures", () => {
  it("strips plain reasoning_content signature from thinking blocks", () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "let me think about this",
            thinkingSignature: "reasoning_content",
          },
          { type: "toolCall", id: "tc_1", name: "search", arguments: {} },
        ],
      },
    ];

    const result = stripReasoningReplaySignatures(input as any);
    const assistant = result[0] as any;
    const thinkingBlock = assistant.content[0];
    expect(thinkingBlock.thinking).toBe("let me think about this");
    expect(thinkingBlock.thinkingSignature).toBeUndefined();
    // Tool call is preserved
    expect(assistant.content[1].type).toBe("toolCall");
  });

  it("strips reasoning and reasoning_text signatures too", () => {
    for (const sig of ["reasoning", "reasoning_text"]) {
      const input = [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm", thinkingSignature: sig },
            { type: "text", text: "answer" },
          ],
        },
      ];
      const result = stripReasoningReplaySignatures(input as any);
      const block = (result[0] as any).content[0];
      expect(block.thinkingSignature).toBeUndefined();
    }
  });

  it("preserves OpenAI Responses API JSON reasoning signatures", () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "reasoning",
            thinkingSignature: JSON.stringify({ id: "rs_abc", type: "reasoning" }),
          },
          { type: "text", text: "answer" },
        ],
      },
    ];

    const result = stripReasoningReplaySignatures(input as any);
    const block = (result[0] as any).content[0];
    expect(block.thinkingSignature).toBe(JSON.stringify({ id: "rs_abc", type: "reasoning" }));
  });

  it("preserves object-form OpenAI reasoning signatures", () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "reasoning",
            thinkingSignature: { id: "rs_obj", type: "reasoning" },
          },
          { type: "text", text: "answer" },
        ],
      },
    ];

    const result = stripReasoningReplaySignatures(input as any);
    const block = (result[0] as any).content[0];
    expect(block.thinkingSignature).toEqual({ id: "rs_obj", type: "reasoning" });
  });

  it("passes through non-assistant messages unchanged", () => {
    const input = [
      { role: "user", content: "hello" },
      { role: "system", content: "you are helpful" },
    ];

    const result = stripReasoningReplaySignatures(input as any);
    expect(result).toEqual(input);
  });

  it("passes through assistant messages without thinking blocks", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
      },
    ];

    const result = stripReasoningReplaySignatures(input as any);
    expect(result).toEqual(input);
  });

  it("passes through thinking blocks without thinkingSignature", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "answer" },
        ],
      },
    ];

    const result = stripReasoningReplaySignatures(input as any);
    expect(result).toEqual(input);
  });

  it("handles empty messages array", () => {
    expect(stripReasoningReplaySignatures([])).toEqual([]);
  });
});

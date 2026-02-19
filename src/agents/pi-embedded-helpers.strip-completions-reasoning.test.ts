import { describe, expect, it } from "vitest";
import { stripCompletionsReasoningFieldSignatures } from "./pi-embedded-helpers.js";

describe("stripCompletionsReasoningFieldSignatures", () => {
  it("drops thinking blocks with reasoning_text field name", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal thought", thinkingSignature: "reasoning_text" },
          { type: "text", text: "answer" },
        ],
      },
    ];

    // oxlint-disable-next-line typescript/no-explicit-any
    const result = stripCompletionsReasoningFieldSignatures(input as any);
    expect(result).toEqual([{ role: "assistant", content: [{ type: "text", text: "answer" }] }]);
  });

  it("drops thinking blocks with reasoning_content field name", () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "thought",
            thinkingSignature: "reasoning_content",
          },
          { type: "text", text: "reply" },
        ],
      },
    ];

    // oxlint-disable-next-line typescript/no-explicit-any
    const result = stripCompletionsReasoningFieldSignatures(input as any);
    expect(result).toEqual([{ role: "assistant", content: [{ type: "text", text: "reply" }] }]);
  });

  it("drops thinking blocks with reasoning field name", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", thinkingSignature: "reasoning" },
          { type: "text", text: "ok" },
        ],
      },
    ];

    // oxlint-disable-next-line typescript/no-explicit-any
    const result = stripCompletionsReasoningFieldSignatures(input as any);
    expect(result).toEqual([{ role: "assistant", content: [{ type: "text", text: "ok" }] }]);
  });

  it("keeps thinking blocks with real base64 signatures", () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "thought",
            thinkingSignature: "dGhpcyBpcyBhIHJlYWwgc2lnbmF0dXJl",
          },
          { type: "text", text: "answer" },
        ],
      },
    ];

    // oxlint-disable-next-line typescript/no-explicit-any
    expect(stripCompletionsReasoningFieldSignatures(input as any)).toEqual(input);
  });

  it("keeps thinking blocks with no thinkingSignature", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "thought" },
          { type: "text", text: "answer" },
        ],
      },
    ];

    // oxlint-disable-next-line typescript/no-explicit-any
    expect(stripCompletionsReasoningFieldSignatures(input as any)).toEqual(input);
  });

  it("drops entire assistant message when only block is a bad thinking block", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "thought", thinkingSignature: "reasoning_text" }],
      },
      { role: "user", content: "next" },
    ];

    // oxlint-disable-next-line typescript/no-explicit-any
    const result = stripCompletionsReasoningFieldSignatures(input as any);
    expect(result).toEqual([{ role: "user", content: "next" }]);
  });

  it("passes through non-assistant messages unchanged", () => {
    const input = [
      { role: "user", content: "hello" },
      { role: "system", content: "you are helpful" },
    ];

    // oxlint-disable-next-line typescript/no-explicit-any
    expect(stripCompletionsReasoningFieldSignatures(input as any)).toEqual(input);
  });

  it("handles mixed valid and invalid thinking blocks", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "bad", thinkingSignature: "reasoning_content" },
          { type: "thinking", thinking: "good", thinkingSignature: "dGVzdA==" },
          { type: "text", text: "answer" },
        ],
      },
    ];

    // oxlint-disable-next-line typescript/no-explicit-any
    const result = stripCompletionsReasoningFieldSignatures(input as any);
    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "good", thinkingSignature: "dGVzdA==" },
          { type: "text", text: "answer" },
        ],
      },
    ]);
  });
});

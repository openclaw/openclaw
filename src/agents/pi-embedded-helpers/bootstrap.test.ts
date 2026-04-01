import { describe, expect, it } from "vitest";
import { stripThoughtSignatures } from "./bootstrap.js";

describe("stripThoughtSignatures", () => {
  it("preserves thinking and redacted_thinking blocks verbatim", () => {
    const thinkingBlock = {
      type: "thinking",
      thinking: "internal",
      thoughtSignature: "msg_123",
    };
    const redactedBlock = {
      type: "redacted_thinking",
      redacted_thinking: "...",
      thoughtSignature: "msg_456",
    };
    const textBlock = {
      type: "text",
      text: "visible",
      thoughtSignature: "msg_789",
    };

    const result = stripThoughtSignatures([thinkingBlock, redactedBlock, textBlock], {
      includeCamelCase: true,
    });

    expect(result[0]).toBe(thinkingBlock);
    expect(result[1]).toBe(redactedBlock);
    expect(result[2]).toEqual({
      type: "text",
      text: "visible",
    });
  });
});

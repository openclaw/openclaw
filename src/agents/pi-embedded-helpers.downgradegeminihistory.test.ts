import { describe, expect, it } from "vitest";
import { downgradeGeminiHistory } from "./pi-embedded-helpers.js";

describe("downgradeGeminiHistory", () => {
  it("drops unsigned tool calls and matching tool results", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "hello" },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "/tmp" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        content: [{ type: "text", text: "ok" }],
      },
      { role: "user", content: "next" },
    ];

    expect(downgradeGeminiHistory(input)).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
      { role: "user", content: "next" },
    ]);
  });

  it("keeps signed tool calls and results", () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_2",
            name: "read",
            arguments: { path: "/tmp" },
            thought_signature: "sig_123",
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_2",
        content: [{ type: "text", text: "ok" }],
      },
    ];

    expect(downgradeGeminiHistory(input)).toEqual(input);
  });

  it("drops assistant messages that only contain unsigned tool calls", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_3", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_3",
        content: [{ type: "text", text: "ok" }],
      },
      { role: "user", content: "after" },
    ];

    expect(downgradeGeminiHistory(input)).toEqual([{ role: "user", content: "after" }]);
  });
});

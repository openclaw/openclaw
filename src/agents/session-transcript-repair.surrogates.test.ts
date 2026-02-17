import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { repairLoneSurrogates } from "./session-transcript-repair.js";

describe("repairLoneSurrogates", () => {
  it("replaces lone high surrogate with replacement character", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "hello \uD83E world" }],
      },
    ] as AgentMessage[];

    const result = repairLoneSurrogates(messages);
    const text = (result[0] as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toBe("hello \uFFFD world");
  });

  it("replaces lone low surrogate with replacement character", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "test \uDDE9 end" }],
      },
    ] as AgentMessage[];

    const result = repairLoneSurrogates(messages);
    const text = (result[0] as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toBe("test \uFFFD end");
  });

  it("preserves valid surrogate pairs (supplementary plane emoji)", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "puzzle \uD83E\uDDE9 piece" }],
      },
    ] as AgentMessage[];

    const result = repairLoneSurrogates(messages);
    const text = (result[0] as { content: Array<{ text: string }> }).content[0].text;
    // Valid pair should be preserved as-is
    expect(text).toBe("puzzle \uD83E\uDDE9 piece");
    expect(text).toBe("puzzle 🧩 piece");
  });

  it("repairs lone surrogates inside tool_use input objects", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc_1",
            name: "message",
            input: { label: "\uD83E Check", emoji: "test \uDDE9" },
          },
        ],
      },
    ] as AgentMessage[];

    const result = repairLoneSurrogates(messages);
    const block = (result[0] as { content: Array<{ input: Record<string, string> }> }).content[0];
    expect(block.input.label).toBe("\uFFFD Check");
    expect(block.input.emoji).toBe("test \uFFFD");
  });

  it("returns same reference when no surrogates need repair", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "plain ASCII text" }],
      },
    ] as AgentMessage[];

    const result = repairLoneSurrogates(messages);
    expect(result).toBe(messages);
  });

  it("handles deeply nested objects", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc_2",
            name: "render",
            input: {
              components: [{ buttons: [{ label: "\uD83E button" }] }],
            },
          },
        ],
      },
    ] as AgentMessage[];

    const result = repairLoneSurrogates(messages);
    const input = (result[0] as { content: Array<{ input: unknown }> }).content[0].input as {
      components: Array<{ buttons: Array<{ label: string }> }>;
    };
    expect(input.components[0].buttons[0].label).toBe("\uFFFD button");
  });
});

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  mergeConsecutiveUserTurns,
  validateAnthropicTurns,
  validateGeminiTurns,
} from "./pi-embedded-helpers.js";

describe("validateGeminiTurns", () => {
  it("should return empty array unchanged", () => {
    const result = validateGeminiTurns([]);
    expect(result).toEqual([]);
  });

  it("should return single message unchanged", () => {
    const msgs: AgentMessage[] = [
      {
        role: "user",
        content: "Hello",
      },
    ];
    const result = validateGeminiTurns(msgs);
    expect(result).toEqual(msgs);
  });

  it("should leave alternating user/assistant unchanged", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      { role: "user", content: "How are you?" },
      { role: "assistant", content: [{ type: "text", text: "Good!" }] },
    ];
    const result = validateGeminiTurns(msgs);
    expect(result).toHaveLength(4);
    expect(result).toEqual(msgs);
  });

  it("should merge consecutive assistant messages", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Part 1" }],
        stopReason: "end_turn",
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Part 2" }],
        stopReason: "end_turn",
      },
      { role: "user", content: "How are you?" },
    ];

    const result = validateGeminiTurns(msgs);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: "user", content: "Hello" });
    expect(result[1].role).toBe("assistant");
    expect(result[1].content).toHaveLength(2);
    expect(result[2]).toEqual({ role: "user", content: "How are you?" });
  });

  it("should preserve metadata from later message when merging", () => {
    const msgs: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "Part 1" }],
        usage: { input: 10, output: 5 },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Part 2" }],
        usage: { input: 10, output: 10 },
        stopReason: "end_turn",
      },
    ];

    const result = validateGeminiTurns(msgs);

    expect(result).toHaveLength(1);
    const merged = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(merged.usage).toEqual({ input: 10, output: 10 });
    expect(merged.stopReason).toBe("end_turn");
    expect(merged.content).toHaveLength(2);
  });

  it("should handle toolResult messages without merging", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: "Use tool" },
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "tool-1", name: "test", input: {} }],
      },
      {
        role: "toolResult",
        toolUseId: "tool-1",
        content: [{ type: "text", text: "Found data" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Here's the answer" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Extra thoughts" }],
      },
      { role: "user", content: "Request 2" },
    ];

    const result = validateGeminiTurns(msgs);

    // Should merge the consecutive assistants
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
    expect(result[2].role).toBe("toolResult");
    expect(result[3].role).toBe("assistant");
    expect(result[4].role).toBe("user");
  });
});

describe("validateAnthropicTurns", () => {
  it("should return empty array unchanged", () => {
    const result = validateAnthropicTurns([]);
    expect(result).toEqual([]);
  });

  it("should return single message unchanged", () => {
    const msgs: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    ];
    const result = validateAnthropicTurns(msgs);
    expect(result).toEqual(msgs);
  });

  it("should return alternating user/assistant unchanged", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "Question" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "Answer" }],
      },
      { role: "user", content: [{ type: "text", text: "Follow-up" }] },
    ];
    const result = validateAnthropicTurns(msgs);
    expect(result).toEqual(msgs);
  });

  it("should merge consecutive user messages", () => {
    const msgs: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "First message" }],
        timestamp: 1000,
      },
      {
        role: "user",
        content: [{ type: "text", text: "Second message" }],
        timestamp: 2000,
      },
    ];

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    const content = (result[0] as { content: unknown[] }).content;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "First message" });
    expect(content[1]).toEqual({ type: "text", text: "Second message" });
    // Should take timestamp from the newer message
    expect((result[0] as { timestamp?: number }).timestamp).toBe(2000);
  });

  it("should merge three consecutive user messages", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "One" }] },
      { role: "user", content: [{ type: "text", text: "Two" }] },
      { role: "user", content: [{ type: "text", text: "Three" }] },
    ];

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(1);
    const content = (result[0] as { content: unknown[] }).content;
    expect(content).toHaveLength(3);
  });

  it("keeps newest metadata when merging consecutive users", () => {
    const msgs: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Old" }],
        timestamp: 1000,
        attachments: [{ type: "image", url: "old.png" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "New" }],
        timestamp: 2000,
        attachments: [{ type: "image", url: "new.png" }],
        someCustomField: "keep-me",
      } as AgentMessage,
    ];

    const result = validateAnthropicTurns(msgs) as Extract<
      AgentMessage,
      { role: "user" }
    >[];

    expect(result).toHaveLength(1);
    const merged = result[0];
    expect(merged.timestamp).toBe(2000);
    expect((merged as { attachments?: unknown[] }).attachments).toEqual([
      { type: "image", url: "new.png" },
    ]);
    expect((merged as { someCustomField?: string }).someCustomField).toBe(
      "keep-me",
    );
    expect(merged.content).toEqual([
      { type: "text", text: "Old" },
      { type: "text", text: "New" },
    ]);
  });

  it("merges consecutive users with images and preserves order", () => {
    const msgs: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "image", url: "img1" },
        ],
      },
      {
        role: "user",
        content: [
          { type: "image", url: "img2" },
          { type: "text", text: "second" },
        ],
      },
    ];

    const [merged] = validateAnthropicTurns(msgs) as Extract<
      AgentMessage,
      { role: "user" }
    >[];
    expect(merged.content).toEqual([
      { type: "text", text: "first" },
      { type: "image", url: "img1" },
      { type: "image", url: "img2" },
      { type: "text", text: "second" },
    ]);
  });

  it("should not merge consecutive assistant messages", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "Question" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "Answer 1" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Answer 2" }],
      },
    ];

    const result = validateAnthropicTurns(msgs);

    // validateAnthropicTurns only merges user messages, not assistant
    expect(result).toHaveLength(3);
  });

  it("should handle mixed scenario with steering messages", () => {
    // Simulates: user asks -> assistant errors -> steering user message injected
    const msgs: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "Original question" }] },
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Overloaded",
      },
      {
        role: "user",
        content: [{ type: "text", text: "Steering: try again" }],
      },
      { role: "user", content: [{ type: "text", text: "Another follow-up" }] },
    ];

    const result = validateAnthropicTurns(msgs);

    // The two consecutive user messages at the end should be merged
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
    expect(result[2].role).toBe("user");
    const lastContent = (result[2] as { content: unknown[] }).content;
    expect(lastContent).toHaveLength(2);
  });
});

describe("mergeConsecutiveUserTurns", () => {
  it("keeps newest metadata while merging content", () => {
    const previous: Extract<AgentMessage, { role: "user" }> = {
      role: "user",
      content: [{ type: "text", text: "before" }],
      timestamp: 1000,
      attachments: [{ type: "image", url: "old.png" }],
    };
    const current: Extract<AgentMessage, { role: "user" }> = {
      role: "user",
      content: [{ type: "text", text: "after" }],
      timestamp: 2000,
      attachments: [{ type: "image", url: "new.png" }],
      someCustomField: "keep-me",
    } as AgentMessage;

    const merged = mergeConsecutiveUserTurns(previous, current);

    expect(merged.content).toEqual([
      { type: "text", text: "before" },
      { type: "text", text: "after" },
    ]);
    expect((merged as { attachments?: unknown[] }).attachments).toEqual([
      { type: "image", url: "new.png" },
    ]);
    expect((merged as { someCustomField?: string }).someCustomField).toBe(
      "keep-me",
    );
    expect(merged.timestamp).toBe(2000);
  });

  it("backfills timestamp from earlier message when missing", () => {
    const previous: Extract<AgentMessage, { role: "user" }> = {
      role: "user",
      content: [{ type: "text", text: "before" }],
      timestamp: 1000,
    };
    const current: Extract<AgentMessage, { role: "user" }> = {
      role: "user",
      content: [{ type: "text", text: "after" }],
    };

    const merged = mergeConsecutiveUserTurns(previous, current);

    expect(merged.timestamp).toBe(1000);
  });
});

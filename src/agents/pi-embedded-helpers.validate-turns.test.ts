import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  dropAllTrailingNonUserTurns,
  dropTrailingEmptyAssistantTurns,
  mergeConsecutiveUserTurns,
  messagesEndWithUserTurn,
  shouldShortCircuitForMissingUserTail,
  validateAnthropicTurns,
  validateGeminiTurns,
} from "./pi-embedded-helpers.js";

function asMessages(messages: unknown[]): AgentMessage[] {
  return messages as AgentMessage[];
}

function makeDualToolUseAssistantContent() {
  return [
    { type: "toolUse", id: "tool-1", name: "test1", arguments: {} },
    { type: "toolUse", id: "tool-2", name: "test2", arguments: {} },
    { type: "text", text: "Done" },
  ];
}

function makeDualToolAnthropicTurns(nextUserContent: unknown[]) {
  return asMessages([
    { role: "user", content: [{ type: "text", text: "Use tools" }] },
    {
      role: "assistant",
      content: makeDualToolUseAssistantContent(),
    },
    {
      role: "user",
      content: nextUserContent,
    },
  ]);
}

function makeSignedThinkingGatewayToolCall(toolId: string) {
  return [
    { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
    { type: "toolCall", id: toolId, name: "gateway", arguments: {} },
  ];
}

function expectAssistantToolCallsOmitted(result: AgentMessage[], expectedLength: number) {
  expect(result).toHaveLength(expectedLength);
  expect((result[1] as { role?: unknown }).role).toBe("assistant");
  expect((result[1] as { content?: unknown[] }).content).toEqual([
    { type: "text", text: "[tool calls omitted]" },
  ]);
}

describe("validate turn edge cases", () => {
  it("returns empty array unchanged", () => {
    expect(validateGeminiTurns([])).toEqual([]);
    expect(validateAnthropicTurns([])).toEqual([]);
  });

  it("returns single message unchanged", () => {
    const geminiMsgs = asMessages([
      {
        role: "user",
        content: "Hello",
      },
    ]);
    const anthropicMsgs = asMessages([
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    ]);
    expect(validateGeminiTurns(geminiMsgs)).toEqual(geminiMsgs);
    expect(validateAnthropicTurns(anthropicMsgs)).toEqual(anthropicMsgs);
  });
});

describe("validateGeminiTurns", () => {
  it("should leave alternating user/assistant unchanged", () => {
    const msgs = asMessages([
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      { role: "user", content: "How are you?" },
      { role: "assistant", content: [{ type: "text", text: "Good!" }] },
    ]);
    const result = validateGeminiTurns(msgs);
    expect(result).toHaveLength(4);
    expect(result).toEqual(msgs);
  });

  it("should merge consecutive assistant messages", () => {
    const msgs = asMessages([
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
    ]);

    const result = validateGeminiTurns(msgs);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: "user", content: "Hello" });
    expect(result[1].role).toBe("assistant");
    expect((result[1] as { content?: unknown[] }).content).toHaveLength(2);
    expect(result[2]).toEqual({ role: "user", content: "How are you?" });
  });

  it("should preserve metadata from later message when merging", () => {
    const msgs = asMessages([
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
    ]);

    const result = validateGeminiTurns(msgs);

    expect(result).toHaveLength(1);
    const merged = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(merged.usage).toEqual({ input: 10, output: 10 });
    expect(merged.stopReason).toBe("end_turn");
    expect(merged.content).toHaveLength(2);
  });

  it("should handle toolResult messages without merging", () => {
    const msgs = asMessages([
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
    ]);

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
  it("should return alternating user/assistant unchanged", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Question" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "Answer" }],
      },
      { role: "user", content: [{ type: "text", text: "Follow-up" }] },
    ]);
    const result = validateAnthropicTurns(msgs);
    expect(result).toEqual(msgs);
  });

  it("should merge consecutive user messages", () => {
    const msgs = asMessages([
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
    ]);

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
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "One" }] },
      { role: "user", content: [{ type: "text", text: "Two" }] },
      { role: "user", content: [{ type: "text", text: "Three" }] },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(1);
    const content = (result[0] as { content: unknown[] }).content;
    expect(content).toHaveLength(3);
  });

  it("keeps newest metadata when merging consecutive users", () => {
    const msgs = asMessages([
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
    ]);

    const result = validateAnthropicTurns(msgs) as Extract<AgentMessage, { role: "user" }>[];

    expect(result).toHaveLength(1);
    const merged = result[0];
    expect(merged.timestamp).toBe(2000);
    expect((merged as { attachments?: unknown[] }).attachments).toEqual([
      { type: "image", url: "new.png" },
    ]);
    expect((merged as { someCustomField?: string }).someCustomField).toBe("keep-me");
    expect(merged.content).toEqual([
      { type: "text", text: "Old" },
      { type: "text", text: "New" },
    ]);
  });

  it("merges consecutive users with images and preserves order", () => {
    const msgs = asMessages([
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
    ]);

    const [merged] = validateAnthropicTurns(msgs) as Extract<AgentMessage, { role: "user" }>[];
    expect(merged.content).toEqual([
      { type: "text", text: "first" },
      { type: "image", url: "img1" },
      { type: "image", url: "img2" },
      { type: "text", text: "second" },
    ]);
  });

  it("should not merge consecutive assistant messages", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Question" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "Answer 1" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Answer 2" }],
      },
    ]);

    const result = validateAnthropicTurns(msgs);

    // validateAnthropicTurns only merges user messages, not assistant
    expect(result).toHaveLength(3);
  });

  it("should handle mixed scenario with steering messages", () => {
    // Simulates: user asks -> assistant errors -> steering user message injected
    const msgs = asMessages([
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
    ]);

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
    const previous = {
      role: "user",
      content: [{ type: "text", text: "before" }],
      timestamp: 1000,
      attachments: [{ type: "image", url: "old.png" }],
    } as Extract<AgentMessage, { role: "user" }>;
    const current = {
      role: "user",
      content: [{ type: "text", text: "after" }],
      timestamp: 2000,
      attachments: [{ type: "image", url: "new.png" }],
      someCustomField: "keep-me",
    } as Extract<AgentMessage, { role: "user" }>;

    const merged = mergeConsecutiveUserTurns(previous, current);

    expect(merged.content).toEqual([
      { type: "text", text: "before" },
      { type: "text", text: "after" },
    ]);
    expect((merged as { attachments?: unknown[] }).attachments).toEqual([
      { type: "image", url: "new.png" },
    ]);
    expect((merged as { someCustomField?: string }).someCustomField).toBe("keep-me");
    expect(merged.timestamp).toBe(2000);
  });

  it("backfills timestamp from earlier message when missing", () => {
    const previous = {
      role: "user",
      content: [{ type: "text", text: "before" }],
      timestamp: 1000,
    } as Extract<AgentMessage, { role: "user" }>;
    const current = {
      role: "user",
      content: [{ type: "text", text: "after" }],
    } as Extract<AgentMessage, { role: "user" }>;

    const merged = mergeConsecutiveUserTurns(previous, current);

    expect(merged.timestamp).toBe(1000);
  });
});

describe("validateAnthropicTurns strips dangling tool_use blocks", () => {
  it("should strip tool_use blocks without matching tool_result", () => {
    // Simulates: user asks -> assistant has tool_use -> user responds without tool_result
    // This happens after compaction trims history
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        content: [
          { type: "toolUse", id: "tool-1", name: "test", arguments: {} },
          { type: "text", text: "I'll check that" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(3);
    // The dangling tool_use should be stripped, but text content preserved
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    expect(assistantContent).toEqual([{ type: "text", text: "I'll check that" }]);
  });

  it("should preserve tool_use blocks with matching tool_result", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        content: [
          { type: "toolUse", id: "tool-1", name: "test", arguments: {} },
          { type: "text", text: "Here's result" },
        ],
      },
      {
        role: "user",
        content: [
          { type: "toolResult", toolUseId: "tool-1", content: [{ type: "text", text: "Result" }] },
          { type: "text", text: "Thanks" },
        ],
      },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(3);
    // tool_use should be preserved because matching tool_result exists
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    expect(assistantContent).toEqual([
      { type: "toolUse", id: "tool-1", name: "test", arguments: {} },
      { type: "text", text: "Here's result" },
    ]);
  });

  it("should insert fallback text when all content would be removed", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "tool-1", name: "test", arguments: {} }],
      },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(3);
    // Should insert fallback text since all content would be removed
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    expect(assistantContent).toEqual([{ type: "text", text: "[tool calls omitted]" }]);
  });

  it("leaves aborted tool-only assistant turns empty instead of synthesizing fallback text", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        stopReason: "aborted",
        content: [{ type: "toolCall", id: "tool-1", name: "test", arguments: {} }],
      },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(3);
    expect((result[1] as { content?: unknown[] }).content).toEqual([]);
  });

  it("should handle multiple dangling tool_use blocks", () => {
    const msgs = makeDualToolAnthropicTurns([{ type: "text", text: "OK" }]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(3);
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    // Only text content should remain
    expect(assistantContent).toEqual([{ type: "text", text: "Done" }]);
  });

  it("should handle mixed tool_use with some having matching tool_result", () => {
    const msgs = makeDualToolAnthropicTurns([
      {
        type: "toolResult",
        toolUseId: "tool-1",
        content: [{ type: "text", text: "Result 1" }],
      },
      { type: "text", text: "Thanks" },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(3);
    // tool-1 should be preserved (has matching tool_result), tool-2 stripped, text preserved
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    expect(assistantContent).toEqual([
      { type: "toolUse", id: "tool-1", name: "test1", arguments: {} },
      { type: "text", text: "Done" },
    ]);
  });

  it("matches standalone toolResult messages before the next assistant turn", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tool-1", name: "test", arguments: {} }],
      },
      { role: "toolResult", toolCallId: "tool-1", content: [{ type: "text", text: "data" }] },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(4);
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    expect(assistantContent).toEqual([
      { type: "toolCall", id: "tool-1", name: "test", arguments: {} },
    ]);
  });

  it("matches tool result blocks across intermediate non-assistant messages", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        content: [
          { type: "functionCall", id: "tool-1", name: "test", arguments: {} },
          { type: "text", text: "Checking" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "still waiting" }] },
      { role: "tool", toolCallId: "tool-1", content: [{ type: "text", text: "data" }] },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(5);
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    expect(assistantContent).toEqual([
      { type: "functionCall", id: "tool-1", name: "test", arguments: {} },
      { type: "text", text: "Checking" },
    ]);
  });

  it("preserves signed-thinking turns whose sibling tool calls still resolve", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        content: makeSignedThinkingGatewayToolCall("tool-1"),
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "gateway",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(4);
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    expect(assistantContent).toEqual(makeSignedThinkingGatewayToolCall("tool-1"));
  });

  it("drops signed-thinking turns when the only matching tool result is embedded in user content", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        content: [
          makeSignedThinkingGatewayToolCall("tool-1")[0],
          { type: "toolUse", id: "tool-1", name: "gateway", arguments: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "toolResult", toolUseId: "tool-1", content: [{ type: "text", text: "ok" }] },
          { type: "text", text: "Continue" },
        ],
      },
    ]);

    const result = validateAnthropicTurns(msgs);

    expectAssistantToolCallsOmitted(result, 3);
  });

  it("preserves signed-thinking turns when a trusted tool result carries both stale and current id aliases", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        content: makeSignedThinkingGatewayToolCall("tool-current"),
      },
      {
        role: "toolResult",
        toolUseId: "tool-stale",
        toolCallId: "tool-current",
        toolName: "gateway",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(4);
    expect((result[1] as { content?: unknown[] }).content).toEqual(
      makeSignedThinkingGatewayToolCall("tool-current"),
    );
  });

  it("drops signed-thinking turns whose sibling tool calls are dangling", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        content: makeSignedThinkingGatewayToolCall("tool-1"),
      },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
    ]);

    const result = validateAnthropicTurns(msgs);

    expectAssistantToolCallsOmitted(result, 3);
  });

  it("does not trust future tool results with the right id but the wrong tool name", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        content: makeSignedThinkingGatewayToolCall("tool-1"),
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "exec",
        content: [{ type: "text", text: "wrong tool" }],
        isError: false,
      },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
    ]);

    const result = validateAnthropicTurns(msgs);

    expectAssistantToolCallsOmitted(result, 4);
  });

  it("drops redacted-thinking turns whose sibling tool calls are dangling", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "blob", thinkingSignature: "sig_1" },
          { type: "toolUse", id: "tool-1", name: "gateway", arguments: {} },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(3);
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    expect(assistantContent).toEqual([{ type: "text", text: "[tool calls omitted]" }]);
  });

  it("drops trailing empty assistant turn left behind by tool_use stripping", () => {
    // Regression: aborted assistant whose only content was a dangling tool_use
    // gets emptied by stripDanglingAnthropicToolUses. If that empty turn is
    // the tail, Anthropic rejects the request because the conversation does
    // not end with a user turn.
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        stopReason: "aborted",
        content: [{ type: "toolCall", id: "tool-1", name: "test", arguments: {} }],
      },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Use tool" }],
    });
  });

  it("drops trailing assistant turn with only thinking blocks (no outbound text)", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "planning...", thinkingSignature: "sig" }],
        stopReason: "aborted",
      },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("preserves trailing assistant turns that still carry real text content", () => {
    // Guard must not discard legitimate prior assistant output. If a caller
    // ever ships this transcript to Anthropic, the stream wrapper / runner
    // guard is responsible for logging — validateAnthropicTurns should not
    // silently erase the assistant reply.
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toEqual(msgs);
  });

  it("is replay-safe across repeated validation passes", () => {
    const msgs = makeDualToolAnthropicTurns([
      {
        type: "toolResult",
        toolUseId: "tool-1",
        content: [{ type: "text", text: "Result 1" }],
      },
    ]);

    const firstPass = validateAnthropicTurns(msgs);
    const secondPass = validateAnthropicTurns(firstPass);

    expect(secondPass).toEqual(firstPass);
  });

  it("does not crash when assistant content is non-array", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        content: "legacy-content",
      },
      { role: "user", content: [{ type: "text", text: "Thanks" }] },
    ] as unknown as AgentMessage[];

    expect(() => validateAnthropicTurns(msgs)).not.toThrow();
    const result = validateAnthropicTurns(msgs);
    expect(result).toHaveLength(3);
  });
});

describe("dropTrailingEmptyAssistantTurns", () => {
  it("returns the input unchanged when the tail is already user-like", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      { role: "user", content: [{ type: "text", text: "More" }] },
    ]);
    expect(dropTrailingEmptyAssistantTurns(msgs)).toBe(msgs);
  });

  it("drops a single trailing assistant turn with empty content array", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      { role: "assistant", content: [], stopReason: "aborted" },
    ]);
    const result = dropTrailingEmptyAssistantTurns(msgs);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("drops multiple consecutive empty trailing assistant turns", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      { role: "assistant", content: [], stopReason: "error" },
      { role: "assistant", content: [{ type: "text", text: "   " }], stopReason: "aborted" },
    ]);
    const result = dropTrailingEmptyAssistantTurns(msgs);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("keeps a non-empty trailing assistant (guard is for empty tails only)", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      { role: "assistant", content: [{ type: "text", text: "Real reply" }] },
    ]);
    expect(dropTrailingEmptyAssistantTurns(msgs)).toBe(msgs);
  });

  it("does not disturb empty assistant turns in the middle of the transcript", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      { role: "assistant", content: [], stopReason: "aborted" },
      { role: "user", content: [{ type: "text", text: "Retry" }] },
    ]);
    expect(dropTrailingEmptyAssistantTurns(msgs)).toBe(msgs);
  });

  it("leaves gateway error-surface assistant messages intact (first-pass gap)", () => {
    // Regression guard: gateway-surfaced errors (billing errors, prefill
    // rejections, etc.) are injected as real-content assistant turns. They
    // are NOT empty or thinking-only, so dropTrailingEmptyAssistantTurns
    // must not remove them. The runner-level safety net is responsible for
    // stripping them before the Anthropic request goes out.
    const billingMsgs = asMessages([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "API provider returned a billing error: please update payment info.",
          },
        ],
      },
    ]);
    expect(dropTrailingEmptyAssistantTurns(billingMsgs)).toBe(billingMsgs);

    const prefillRejectionMsgs = asMessages([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "LLM request rejected: This model does not support assistant message prefill.",
          },
        ],
      },
    ]);
    expect(dropTrailingEmptyAssistantTurns(prefillRejectionMsgs)).toBe(prefillRejectionMsgs);
  });
});

describe("dropAllTrailingNonUserTurns", () => {
  it("returns the input unchanged when the tail is already user-like", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      { role: "user", content: [{ type: "text", text: "More" }] },
    ]);
    expect(dropAllTrailingNonUserTurns(msgs)).toBe(msgs);
  });

  it("drops a trailing assistant turn that carries real gateway error text", () => {
    // The exact case that slipped past dropTrailingEmptyAssistantTurns and
    // kept firing the old warn-only guard: a surfaced error shows up as a
    // non-empty assistant tail, so the runner must strip it before sending
    // to Anthropic.
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "API provider returned a billing error: please update payment info.",
          },
        ],
      },
    ]);
    const result = dropAllTrailingNonUserTurns(msgs);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(messagesEndWithUserTurn(result)).toBe(true);
  });

  it("drops multiple consecutive non-user trailing turns including real text", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      { role: "assistant", content: [{ type: "text", text: "Reply 1" }] },
      { role: "assistant", content: [{ type: "text", text: "Reply 2 (prefill error)" }] },
    ]);
    const result = dropAllTrailingNonUserTurns(msgs);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("returns an empty array when every message is non-user", () => {
    const msgs = asMessages([
      { role: "assistant", content: [{ type: "text", text: "stray reply" }] },
      { role: "assistant", content: [{ type: "text", text: "another stray" }] },
    ]);
    const result = dropAllTrailingNonUserTurns(msgs);
    expect(result).toHaveLength(0);
  });

  it("preserves user-like tails of tool-result and tool roles", () => {
    const toolResultTail = asMessages([
      { role: "user", content: [{ type: "text", text: "use tool" }] },
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "tool-1", name: "t", arguments: {} }],
      },
      { role: "toolResult", toolUseId: "tool-1", content: [{ type: "text", text: "ok" }] },
    ]);
    expect(dropAllTrailingNonUserTurns(toolResultTail)).toBe(toolResultTail);

    const toolTail = asMessages([
      { role: "user", content: [{ type: "text", text: "use tool" }] },
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "tool-2", name: "t", arguments: {} }],
      },
      { role: "tool", toolCallId: "tool-2", content: [{ type: "text", text: "ok" }] },
    ]);
    expect(dropAllTrailingNonUserTurns(toolTail)).toBe(toolTail);
  });

  it("only touches trailing turns; non-user turns in the middle stay intact", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      { role: "assistant", content: [{ type: "text", text: "mid reply" }] },
      { role: "user", content: [{ type: "text", text: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "billing error text" }] },
    ]);
    const result = dropAllTrailingNonUserTurns(msgs);
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
    expect((result[1] as { content?: unknown[] }).content).toEqual([
      { type: "text", text: "mid reply" },
    ]);
    expect(result[2].role).toBe("user");
    expect(messagesEndWithUserTurn(result)).toBe(true);
  });

  it("returns the input unchanged for an empty array", () => {
    const msgs = asMessages([]);
    expect(dropAllTrailingNonUserTurns(msgs)).toBe(msgs);
  });

  it("is idempotent across repeated passes", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "error" }] },
    ]);
    const once = dropAllTrailingNonUserTurns(msgs);
    const twice = dropAllTrailingNonUserTurns(once);
    expect(twice).toBe(once);
    expect(once).toHaveLength(1);
  });
});

describe("messagesEndWithUserTurn", () => {
  it("returns true for user, toolResult, and tool tails", () => {
    expect(messagesEndWithUserTurn(asMessages([{ role: "user", content: "x" }]))).toBe(true);
    expect(
      messagesEndWithUserTurn(asMessages([{ role: "toolResult", toolUseId: "t", content: [] }])),
    ).toBe(true);
    expect(
      messagesEndWithUserTurn(asMessages([{ role: "tool", toolCallId: "t", content: [] }])),
    ).toBe(true);
  });

  it("returns false when trailing role is assistant", () => {
    expect(
      messagesEndWithUserTurn(
        asMessages([
          { role: "user", content: "x" },
          { role: "assistant", content: [{ type: "text", text: "y" }] },
        ]),
      ),
    ).toBe(false);
  });

  it("returns false for an empty list", () => {
    expect(messagesEndWithUserTurn([])).toBe(false);
  });
});

describe("shouldShortCircuitForMissingUserTail", () => {
  const assistantTail = asMessages([
    { role: "user", content: "x" },
    { role: "assistant", content: [{ type: "text", text: "complete reply" }] },
  ]);
  const userTail = asMessages([
    { role: "user", content: "x" },
    { role: "assistant", content: [{ type: "text", text: "y" }] },
    { role: "user", content: "follow-up" },
  ]);

  it("short-circuits when transcript tail is assistant and prompt is empty without images", () => {
    expect(
      shouldShortCircuitForMissingUserTail({
        validateAnthropicTurns: true,
        messages: assistantTail,
        promptText: "",
        hasImages: false,
      }),
    ).toBe(true);
    expect(
      shouldShortCircuitForMissingUserTail({
        validateAnthropicTurns: true,
        messages: assistantTail,
        promptText: "   \n\t",
        hasImages: false,
      }),
    ).toBe(true);
  });

  it("does not short-circuit when a fresh user prompt will be appended", () => {
    expect(
      shouldShortCircuitForMissingUserTail({
        validateAnthropicTurns: true,
        messages: assistantTail,
        promptText: "hello",
        hasImages: false,
      }),
    ).toBe(false);
  });

  it("does not short-circuit when an image will be appended", () => {
    expect(
      shouldShortCircuitForMissingUserTail({
        validateAnthropicTurns: true,
        messages: assistantTail,
        promptText: "",
        hasImages: true,
      }),
    ).toBe(false);
  });

  it("does not short-circuit when transcript already ends with a user-like turn", () => {
    expect(
      shouldShortCircuitForMissingUserTail({
        validateAnthropicTurns: true,
        messages: userTail,
        promptText: "",
        hasImages: false,
      }),
    ).toBe(false);
  });

  it("does not short-circuit when Anthropic turn validation is disabled", () => {
    expect(
      shouldShortCircuitForMissingUserTail({
        validateAnthropicTurns: false,
        messages: assistantTail,
        promptText: "",
        hasImages: false,
      }),
    ).toBe(false);
  });

  it("does not short-circuit on an empty transcript", () => {
    expect(
      shouldShortCircuitForMissingUserTail({
        validateAnthropicTurns: true,
        messages: [],
        promptText: "",
        hasImages: false,
      }),
    ).toBe(false);
  });

  it("does not short-circuit when the assistant tail is an empty/aborted stub", () => {
    // Regression: a previous attempt can leave an empty or aborted assistant
    // turn in `activeSession.messages` before `dropTrailingEmptyAssistantTurns`
    // has a chance to strip it. The guard must not treat that stale tail as a
    // reason to skip the provider call — the downstream pipeline removes it.
    const emptyAbortedTail = asMessages([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      { role: "assistant", content: [], stopReason: "aborted" },
    ]);
    expect(
      shouldShortCircuitForMissingUserTail({
        validateAnthropicTurns: true,
        messages: emptyAbortedTail,
        promptText: "",
        hasImages: false,
      }),
    ).toBe(false);

    const thinkingOnlyTail = asMessages([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "internal" }],
      },
    ]);
    expect(
      shouldShortCircuitForMissingUserTail({
        validateAnthropicTurns: true,
        messages: thinkingOnlyTail,
        promptText: "",
        hasImages: false,
      }),
    ).toBe(false);
  });
});

describe("heartbeat contamination regression (validateAnthropicTurns)", () => {
  // Reproduces the case where filterHeartbeatPairs removed the trailing
  // (user heartbeat, assistant HEARTBEAT_OK) pair but the subsequent tool_use
  // stripping emptied the prior aborted assistant, leaving nothing sendable
  // after the initial user turn.
  it("emits a transcript ending on a user turn after aborted empty assistant at tail", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Original question" }] },
      {
        role: "assistant",
        stopReason: "aborted",
        content: [{ type: "toolUse", id: "tool-dangling", name: "exec", arguments: {} }],
      },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(1);
    expect(messagesEndWithUserTurn(result)).toBe(true);
  });
});

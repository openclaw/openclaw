import { describe, expect, it } from "vitest";

import {
  emergencyTruncateMessages,
  estimateContextChars,
} from "./pruner.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

const CHARS_PER_TOKEN_ESTIMATE = 4;

function createMessage(
  role: "system" | "user" | "assistant" | "toolResult",
  text: string,
  toolName?: string,
): AgentMessage {
  const base = {
    role,
    content: [{ type: "text" as const, text }],
  } as AgentMessage;

  if (toolName) {
    (base as { toolName: string }).toolName = toolName;
  }

  return base;
}

describe("emergencyTruncateMessages", () => {
  it("does nothing when context is under the limit", () => {
    const messages: AgentMessage[] = [
      createMessage("system", "System prompt"),
      createMessage("user", "Hello"),
      createMessage("assistant", "Hi there!"),
      createMessage("user", "How are you?"),
      createMessage("assistant", "I'm good!"),
    ];

    const truncated = emergencyTruncateMessages({
      messages,
      maxTokens: 100_000, // Well above the actual size
    });

    // Should return messages unchanged when under limit
    expect(truncated.length).toBe(messages.length);
    expect(truncated).toEqual(messages);
  });

  it("truncates to last N user messages when context is over limit", () => {
    const largeText = "x".repeat(50_000); // ~12,500 tokens

    const messages: AgentMessage[] = [
      createMessage("system", "System prompt"),
      createMessage("user", "Old message 1"),
      createMessage("assistant", "Old response 1"),
      createMessage("user", "Old message 2"),
      createMessage("assistant", "Old response 2"),
      createMessage("user", "Old message 3"),
      createMessage("assistant", "Old response 3"),
      createMessage("user", "Old message 4"),
      createMessage("assistant", "Old response 4"),
      createMessage("user", "Old message 5"),
      createMessage("assistant", "Old response 5"),
      createMessage("user", "Old message 6"),
      createMessage("assistant", "Old response 6"),
      createMessage("user", "Old message 7"),
      createMessage("assistant", "Old response 7"),
      createMessage("user", "Old message 8"),
      createMessage("assistant", "Old response 8"),
      createMessage("user", `Recent message 1 ${largeText}`),
      createMessage("assistant", "Recent response 1"),
      createMessage("user", `Recent message 2 ${largeText}`),
      createMessage("assistant", "Recent response 2"),
      createMessage("user", `Recent message 3 ${largeText}`),
      createMessage("assistant", "Recent response 3"),
    ];

    // With 3 messages of 50k chars each (37.5k tokens), set a lower limit to force truncation
    const truncated = emergencyTruncateMessages({
      messages,
      maxTokens: 20_000, // Force truncation
      keepLastMessages: 3,
    });

    // Should have system message + summary + last 6 messages (3 user + 3 assistant)
    expect(truncated.length).toBeLessThan(messages.length);
    expect(truncated.length).toBeGreaterThan(5); // At least system + summary + some messages

    // Last user message should be preserved
    const lastUserIndex = truncated.findIndex(
      (m, i) => m.role === "user" && i > 0,
    );
    expect(lastUserIndex).toBeGreaterThan(0);
  });

  it("preserves system and session header messages", () => {
    const largeText = "x".repeat(100_000); // ~25,000 tokens

    const messages: AgentMessage[] = [
      createMessage("system", "System prompt"),
      createMessage(
        "user",
        JSON.stringify({ type: "session", version: 2, id: "test" }),
      ),
      createMessage("user", `Recent message ${largeText}`),
      createMessage("assistant", "Response"),
    ];

    const truncated = emergencyTruncateMessages({
      messages,
      maxTokens: 10_000,
    });

    // System message and session header should be preserved
    expect(truncated[0].role).toBe("system");
    expect(truncated[1].role).toBe("user");
  });

  it("adds emergency summary message", () => {
    const largeText = "x".repeat(100_000); // ~25,000 tokens

    const messages: AgentMessage[] = [
      createMessage("system", "System prompt"),
      createMessage("user", `Old message ${largeText}`),
      createMessage("assistant", "Old response"),
      createMessage("user", "Recent message"),
      createMessage("assistant", "Recent response"),
    ];

    const truncated = emergencyTruncateMessages({
      messages,
      maxTokens: 10_000,
    });

    // Find the assistant message with the summary
    const summaryMsg = truncated.find((m) => {
      const text = m.content?.[0]?.text as string;
      return (
        m.role === "assistant" &&
        text?.includes("EMERGENCY CONTEXT TRUNCATION")
      );
    });

    expect(summaryMsg).toBeDefined();
    const summaryText = summaryMsg?.content?.[0]?.text as string;
    expect(summaryText).toContain("EMERGENCY CONTEXT TRUNCATION");
  });

  it("respects custom keepLastMessages parameter", () => {
    const largeText = "x".repeat(50_000); // ~12,500 tokens

    const messages: AgentMessage[] = [
      createMessage("system", "System prompt"),
      createMessage("user", `Old 1 ${largeText}`),
      createMessage("assistant", "Old response 1"),
      createMessage("user", `Old 2 ${largeText}`),
      createMessage("assistant", "Old response 2"),
      createMessage("user", "Recent 1"),
      createMessage("assistant", "Response 1"),
      createMessage("user", "Recent 2"),
      createMessage("assistant", "Response 2"),
    ];

    // Keep only last 1 user message
    const truncated = emergencyTruncateMessages({
      messages,
      maxTokens: 20_000, // Force truncation
      keepLastMessages: 1,
    });

    // Count user messages (excluding system)
    const userMessages = truncated.filter((m) => m.role === "user");
    // Should only have the most recent user message
    expect(userMessages.length).toBe(1); // Only "Recent 2" should remain
  });
});

describe("estimateContextChars", () => {
  it("estimates character count for messages", () => {
    const messages: AgentMessage[] = [
      createMessage("system", "System prompt"),
      createMessage("user", "Hello world"),
      createMessage("assistant", "Hi there!"),
    ];

    const chars = estimateContextChars(messages);

    // Content: "System prompt" (13) + "Hello world" (11) + "Hi there!" (9) = 33
    // Plus JSON overhead: 3 * 80 = 240
    // Total: ~273
    expect(chars).toBeGreaterThan(200);
    expect(chars).toBeLessThan(300);
  });

  it("handles tool result messages", () => {
    const largeText = "x".repeat(1000);

    const messages: AgentMessage[] = [
      createMessage("system", "System prompt"),
      createMessage("user", "Hello"),
      createMessage("assistant", "Hi"),
      createMessage("toolResult", largeText, "read"),
    ];

    const chars = estimateContextChars(messages);

    // Content: 1000 + small messages
    // Plus JSON overhead
    expect(chars).toBeGreaterThan(1200);
    expect(chars).toBeLessThan(1400);
  });

  it("handles empty messages array", () => {
    const chars = estimateContextChars([]);
    expect(chars).toBe(0);
  });
});

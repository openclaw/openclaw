import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { computeStaticPromptTokens, planContextMessages } from "./context-planner.js";

function makeTextMessage(role: "user" | "assistant", chars: number): AgentMessage {
  if (role === "user") {
    return {
      role: "user",
      content: [{ type: "text", text: "x".repeat(chars) }],
      timestamp: Date.now(),
    } as AgentMessage;
  }
  return {
    role: "assistant",
    content: [{ type: "text", text: "x".repeat(chars) }],
  } as AgentMessage;
}

describe("context planner", () => {
  it("keeps history unchanged when already under budget", () => {
    const messages: AgentMessage[] = [
      makeTextMessage("user", 200),
      makeTextMessage("assistant", 200),
      makeTextMessage("user", 200),
    ];

    const result = planContextMessages({
      messages,
      contextWindowTokens: 32_000,
      reserveTokens: 4_000,
      staticPromptTokens: 1_500,
    });

    expect(result.trimmed).toBe(false);
    expect(result.reason).toBe("under-budget");
    expect(result.messages).toBe(messages);
    expect(result.droppedMessages).toBe(0);
  });

  it("drops older messages when history exceeds budget", () => {
    const messages: AgentMessage[] = [
      makeTextMessage("user", 8_000),
      makeTextMessage("assistant", 8_000),
      makeTextMessage("user", 8_000),
      makeTextMessage("assistant", 8_000),
      makeTextMessage("user", 8_000),
      makeTextMessage("assistant", 8_000),
    ];

    const result = planContextMessages({
      messages,
      contextWindowTokens: 16_000,
      reserveTokens: 4_000,
      staticPromptTokens: 2_000,
    });

    expect(result.trimmed).toBe(true);
    expect(result.reason).toBe("budget-trimmed");
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.messages[0]).not.toBe(messages[0]);
    expect(result.droppedMessages).toBeGreaterThan(0);
    expect(result.estimatedHistoryTokensAfter).toBeLessThan(result.estimatedHistoryTokensBefore);
  });

  it("always preserves the latest user turn when it alone exceeds budget", () => {
    const messages: AgentMessage[] = [
      makeTextMessage("user", 2_000),
      makeTextMessage("assistant", 2_000),
      makeTextMessage("user", 40_000),
      makeTextMessage("assistant", 30_000),
    ];

    const result = planContextMessages({
      messages,
      contextWindowTokens: 8_000,
      reserveTokens: 2_500,
      staticPromptTokens: 1_500,
    });

    expect(result.trimmed).toBe(true);
    expect(result.reason).toBe("mandatory-tail-only");
    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages).toEqual(messages.slice(2));
  });

  it("falls back to last message when static budget already overflows", () => {
    const messages: AgentMessage[] = [
      makeTextMessage("user", 400),
      makeTextMessage("assistant", 400),
      makeTextMessage("user", 400),
    ];

    const result = planContextMessages({
      messages,
      contextWindowTokens: 2_000,
      reserveTokens: 1_700,
      staticPromptTokens: 1_200,
    });

    expect(result.trimmed).toBe(true);
    expect(result.reason).toBe("invalid-budget");
    expect(result.messages).toEqual(messages.slice(-1));
  });

  it("estimates static prompt token cost from system + user prompt text", () => {
    const total = computeStaticPromptTokens({
      systemPrompt: "System instructions " + "a".repeat(1500),
      prompt: "User task " + "b".repeat(1200),
    });

    expect(total).toBeGreaterThan(0);
  });
});

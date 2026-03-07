import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { limitHistoryTurns } from "./pi-embedded-runner.js";

describe("limitHistoryTurns", () => {
  const mockUsage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  } as const;

  const userMessage = (text: string): AgentMessage =>
    ({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    }) as AgentMessage;

  const assistantTextMessage = (text: string): AgentMessage =>
    ({
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      api: "openai-responses",
      provider: "openai",
      model: "mock-1",
      usage: mockUsage,
      timestamp: Date.now(),
    }) as AgentMessage;

  const assistantToolCallMessage = (id: string): AgentMessage =>
    ({
      role: "assistant",
      content: [{ type: "toolCall", id, name: "exec", arguments: {} }],
      stopReason: "stop",
      api: "openai-responses",
      provider: "openai",
      model: "mock-1",
      usage: mockUsage,
      timestamp: Date.now(),
    }) as AgentMessage;

  const firstText = (message: AgentMessage): string | undefined => {
    if (!("content" in message)) {
      return undefined;
    }
    const content = message.content;
    if (typeof content === "string") {
      return content;
    }
    const first = content[0];
    return first?.type === "text" ? first.text : undefined;
  };

  const makeMessages = (roles: ("user" | "assistant")[]): AgentMessage[] =>
    roles.map((role, i) =>
      role === "user" ? userMessage(`message ${i}`) : assistantTextMessage(`message ${i}`),
    );

  it("returns all messages when limit is undefined", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    expect(limitHistoryTurns(messages, undefined)).toBe(messages);
  });

  it("returns all messages when limit is 0", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    expect(limitHistoryTurns(messages, 0)).toBe(messages);
  });

  it("returns all messages when limit is negative", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    expect(limitHistoryTurns(messages, -1)).toBe(messages);
  });

  it("returns empty array when messages is empty", () => {
    expect(limitHistoryTurns([], 5)).toEqual([]);
  });

  it("keeps all messages when fewer user turns than limit", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    expect(limitHistoryTurns(messages, 10)).toBe(messages);
  });

  it("limits to last N user turns", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant", "user", "assistant"]);
    const limited = limitHistoryTurns(messages, 2);
    expect(limited.length).toBe(4);
    expect(firstText(limited[0])).toBe("message 2");
  });

  it("handles single user turn limit", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant", "user", "assistant"]);
    const limited = limitHistoryTurns(messages, 1);
    expect(limited.length).toBe(2);
    expect(firstText(limited[0])).toBe("message 4");
    expect(firstText(limited[1])).toBe("message 5");
  });

  it("handles messages with multiple assistant responses per user turn", () => {
    const messages = makeMessages(["user", "assistant", "assistant", "user", "assistant"]);
    const limited = limitHistoryTurns(messages, 1);
    expect(limited.length).toBe(2);
    expect(limited[0].role).toBe("user");
    expect(limited[1].role).toBe("assistant");
  });

  it("preserves message content integrity", () => {
    const messages: AgentMessage[] = [
      userMessage("first"),
      assistantToolCallMessage("1"),
      userMessage("second"),
      assistantTextMessage("response"),
    ];
    const limited = limitHistoryTurns(messages, 1);
    expect(firstText(limited[0])).toBe("second");
    expect(firstText(limited[1])).toBe("response");
  });

  it("extends cut to include assistant tool_use when toolResult would be orphaned", () => {
    const toolResultMessage = (toolCallId: string): AgentMessage =>
      ({
        role: "toolResult",
        toolCallId,
        content: [{ type: "text", text: "result" }],
        timestamp: Date.now(),
      }) as AgentMessage;

    // user → assistant [tool_use] → user (interrupt) → toolResult → assistant → user → assistant
    // With limit=2, the naive cut is at index 2 (user "interrupt"), which
    // orphans the toolResult at index 3 because its tool_use at index 1 is removed.
    const messages: AgentMessage[] = [
      userMessage("hello"),
      assistantToolCallMessage("t1"),
      userMessage("interrupt"),
      toolResultMessage("t1"),
      assistantTextMessage("based on tool"),
      userMessage("thanks"),
      assistantTextMessage("done"),
    ];

    const limited = limitHistoryTurns(messages, 2);
    // Cut point should move back to include the assistant tool_use at index 1
    // so that the toolResult at index 3 is not orphaned.
    expect(limited.length).toBe(6);
    expect(limited[0].role).toBe("assistant");
    expect(limited[1].role).toBe("user");
    expect(limited[2].role).toBe("toolResult");
    expect(limited[3].role).toBe("assistant");
    expect(firstText(limited[4])).toBe("thanks");
    expect(firstText(limited[5])).toBe("done");
  });

  it("does not extend cut when tool pairs are complete within kept portion", () => {
    const toolResultMessage = (toolCallId: string): AgentMessage =>
      ({
        role: "toolResult",
        toolCallId,
        content: [{ type: "text", text: "result" }],
        timestamp: Date.now(),
      }) as AgentMessage;

    // Standard flow: tool pairs are within a single turn, no orphaning
    const messages: AgentMessage[] = [
      userMessage("first"),
      assistantTextMessage("reply1"),
      userMessage("do something"),
      assistantToolCallMessage("t1"),
      toolResultMessage("t1"),
      assistantTextMessage("here is the result"),
      userMessage("last"),
      assistantTextMessage("bye"),
    ];

    const limited = limitHistoryTurns(messages, 1);
    // Cut at user "last" — no toolResult before the first assistant, so no extension needed.
    expect(limited.length).toBe(2);
    expect(firstText(limited[0])).toBe("last");
    expect(firstText(limited[1])).toBe("bye");
  });

  it("does not extend cut when complete tool pairs are before the cut", () => {
    const toolResultMessage = (toolCallId: string): AgentMessage =>
      ({
        role: "toolResult",
        toolCallId,
        content: [{ type: "text", text: "result" }],
        timestamp: Date.now(),
      }) as AgentMessage;

    const messages: AgentMessage[] = [
      userMessage("start"),
      assistantToolCallMessage("t1"),
      toolResultMessage("t1"),
      assistantToolCallMessage("t2"),
      toolResultMessage("t2"),
      assistantTextMessage("summary"),
      userMessage("next"),
      assistantTextMessage("done"),
    ];

    const limited = limitHistoryTurns(messages, 1);
    // Cut at user "next" — no toolResult in kept portion before first assistant.
    expect(limited.length).toBe(2);
    expect(firstText(limited[0])).toBe("next");
    expect(firstText(limited[1])).toBe("done");
  });
});

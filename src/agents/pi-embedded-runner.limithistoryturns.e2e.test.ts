import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { limitHistoryTurns } from "./pi-embedded-runner.js";

describe("limitHistoryTurns", () => {
  const makeMessages = (roles: ("user" | "assistant")[]): AgentMessage[] =>
    roles.map((role, i) => ({
      role,
      content: [{ type: "text", text: `message ${i}` }],
    }));

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
    expect(limited[0].content).toEqual([{ type: "text", text: "message 2" }]);
  });

  it("handles single user turn limit", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant", "user", "assistant"]);
    const limited = limitHistoryTurns(messages, 1);
    expect(limited.length).toBe(2);
    expect(limited[0].content).toEqual([{ type: "text", text: "message 4" }]);
    expect(limited[1].content).toEqual([{ type: "text", text: "message 5" }]);
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
      { role: "user", content: [{ type: "text", text: "first" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "1", name: "exec", arguments: {} }],
      },
      { role: "user", content: [{ type: "text", text: "second" }] },
      { role: "assistant", content: [{ type: "text", text: "response" }] },
    ];
    const limited = limitHistoryTurns(messages, 1);
    expect(limited[0].content).toEqual([{ type: "text", text: "second" }]);
    expect(limited[1].content).toEqual([{ type: "text", text: "response" }]);
  });
});

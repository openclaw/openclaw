import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { sanitizeThinkingForRecovery } from "./anthropic.js";

describe("sanitizeThinkingForRecovery", () => {
  it("drops last assistant msg when thinking block has no signature (crash mid-thinking)", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "partial thought...", signature: undefined }],
      } as AgentMessage,
    ];
    const result = sanitizeThinkingForRecovery(messages);
    expect(result.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(result.prefill).toBe(false);
  });

  it("drops last assistant msg when thinking block is empty (crash at thinking start)", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: undefined, signature: undefined }],
      } as AgentMessage,
    ];
    const result = sanitizeThinkingForRecovery(messages);
    expect(result.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(result.prefill).toBe(false);
  });

  it("preserves trailing turns when dropping incomplete assistant (user turn after)", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "partial thought...", signature: undefined }],
      } as AgentMessage,
      { role: "user", content: "follow up question" } as AgentMessage,
    ];
    const result = sanitizeThinkingForRecovery(messages);
    expect(result.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "user", content: "follow up question" },
    ]);
    expect(result.prefill).toBe(false);
  });

  it("marks prefill when thinking is signed but no text block exists (crash between phases)", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "complete thought", signature: "sig123" }],
      } as AgentMessage,
    ];
    const result = sanitizeThinkingForRecovery(messages);
    expect(result.messages).toEqual(messages);
    expect(result.prefill).toBe(true);
  });

  it("marks prefill when thinking is signed but text block is empty (crash mid-text)", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" } as AgentMessage,
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "full reasoning chain", signature: "sig456" },
          { type: "text", text: "" },
        ],
      } as AgentMessage,
    ];
    const result = sanitizeThinkingForRecovery(messages);
    expect(result.messages).toEqual(messages);
    expect(result.prefill).toBe(true);
  });

  it("treats partial text as valid when thinking is signed (non-empty text block)", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" } as AgentMessage,
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "full reasoning", signature: "sig789" },
          { type: "text", text: "Here is my answ" },
        ],
      } as AgentMessage,
    ];
    const result = sanitizeThinkingForRecovery(messages);
    expect(result.messages).toEqual(messages);
    expect(result.prefill).toBe(false);
  });

  it("preserves complete last assistant msg with thinking + text", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" } as AgentMessage,
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should greet them", signature: "sigABC" },
          { type: "text", text: "Hi there!" },
        ],
      } as AgentMessage,
    ];
    const result = sanitizeThinkingForRecovery(messages);
    expect(result.messages).toEqual(messages);
    expect(result.prefill).toBe(false);
  });

  it("preserves last assistant msg with only text (no thinking)", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" } as AgentMessage,
      { role: "assistant", content: [{ type: "text", text: "Hi there!" }] } as AgentMessage,
    ];
    const result = sanitizeThinkingForRecovery(messages);
    expect(result.messages).toEqual(messages);
    expect(result.prefill).toBe(false);
  });

  it("handles string content assistant messages unchanged", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" } as AgentMessage,
      { role: "assistant", content: "plain text response" } as unknown as AgentMessage,
    ];
    const result = sanitizeThinkingForRecovery(messages);
    expect(result.messages).toEqual(messages);
    expect(result.prefill).toBe(false);
  });

  it("does NOT strip thinking from non-latest assistant messages", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" } as AgentMessage,
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "old thought", signature: "sigOLD" },
          { type: "text", text: "Hi!" },
        ],
      } as AgentMessage,
      { role: "user", content: "how are you?" } as AgentMessage,
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "current thought", signature: "sigNEW" },
          { type: "text", text: "Great!" },
        ],
      } as AgentMessage,
    ];
    const result = sanitizeThinkingForRecovery(messages);
    expect(result.messages).toEqual(messages);
    expect(result.prefill).toBe(false);
  });
});

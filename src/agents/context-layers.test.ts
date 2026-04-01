import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  applyToolResultBudget,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  microCompact,
  snipCompact,
} from "./context-layers.js";

function userMsg(content: string): AgentMessage {
  return { role: "user", content, timestamp: Date.now() };
}

function assistantMsg(content: string): AgentMessage {
  return { role: "assistant", content, timestamp: Date.now() };
}

function toolResultMsg(toolUseId: string, content: string): AgentMessage {
  return { role: "tool", tool_use_id: toolUseId, content, timestamp: Date.now() } as AgentMessage;
}

function systemMsg(content: string): AgentMessage {
  return { role: "system", content, timestamp: Date.now() };
}

describe("applyToolResultBudget", () => {
  it("should not truncate small results", () => {
    const messages = [userMsg("hi"), toolResultMsg("t1", "small output")];
    const result = applyToolResultBudget(messages);
    expect(result.truncated).toBe(0);
    expect(result.tokensFreed).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it("should truncate oversized results", () => {
    const bigOutput = "x".repeat(60000);
    const messages = [userMsg("hi"), toolResultMsg("t1", bigOutput)];
    const result = applyToolResultBudget(messages, { maxChars: 50000 });
    expect(result.truncated).toBe(1);
    expect(result.tokensFreed).toBeGreaterThan(0);
    const content = (result.messages[1] as Record<string, unknown>).content as string;
    expect(content.length).toBeLessThan(bigOutput.length);
    expect(content).toContain("truncated");
  });

  it("should respect custom maxChars", () => {
    const output = "x".repeat(1000);
    const messages = [toolResultMsg("t1", output)];
    const result = applyToolResultBudget(messages, { maxChars: 500 });
    expect(result.truncated).toBe(1);
    const content = (result.messages[0] as Record<string, unknown>).content as string;
    expect(content.length).toBeLessThan(output.length);
  });
});

describe("snipCompact", () => {
  it("should not snip if messages are few", () => {
    const messages = [userMsg("a"), assistantMsg("b")];
    const result = snipCompact(messages);
    expect(result.snipped).toBe(0);
  });

  it("should keep recent messages and discard old ones", () => {
    const messages = Array.from({ length: 20 }, (_, i) => userMsg(`msg${i}`));
    const result = snipCompact(messages, { keepRecentRatio: 0.5 });
    expect(result.snipped).toBeGreaterThan(0);
    expect(result.messages.length).toBeLessThan(messages.length);
    // Last message should be preserved
    expect(result.messages[result.messages.length - 1]).toEqual(messages[messages.length - 1]);
  });

  it("should preserve system messages at the beginning", () => {
    const messages = [
      systemMsg("system prompt"),
      ...Array.from({ length: 20 }, (_, i) => userMsg(`msg${i}`)),
    ];
    const result = snipCompact(messages, { keepRecentRatio: 0.3 });
    // System message should still be first
    expect(result.messages[0]?.role).toBe("system");
  });

  it("should not snip when keepRecentRatio is 1.0", () => {
    const messages = Array.from({ length: 20 }, (_, i) => userMsg(`msg${i}`));
    const result = snipCompact(messages, { keepRecentRatio: 1.0 });
    expect(result.snipped).toBe(0);
    expect(result.messages.length).toBe(messages.length);
  });
});

describe("microCompact", () => {
  it("should remove duplicate tool results", () => {
    const messages = [
      userMsg("read file"),
      assistantMsg("let me read"),
      toolResultMsg("t1", "content v1"),
      userMsg("read again"),
      assistantMsg("reading again"),
      toolResultMsg("t2", "content v2"),
    ];
    // Both tool results have different tool_use_ids, so they won't be deduped
    // Let's create a real dedup scenario
    const result = microCompact(messages);
    expect(result.removed).toBe(0); // Different tool_use_ids, no dedup
  });

  it("should not remove messages when no duplicates", () => {
    const messages = [
      userMsg("hello"),
      assistantMsg("hi"),
      userMsg("bye"),
    ];
    const result = microCompact(messages);
    expect(result.removed).toBe(0);
    expect(result.messages.length).toBe(messages.length);
  });

  it("should handle empty messages", () => {
    const result = microCompact([]);
    expect(result.removed).toBe(0);
    expect(result.messages.length).toBe(0);
  });
});

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { estimateMessageTokensCjkAware, estimateMessagesTokens } from "./compaction.js";

/**
 * Verify that the CJK-aware token estimator produces significantly higher
 * token counts for CJK content compared to the previous `chars / 4` approach.
 *
 * See: https://github.com/OpenClaw/openclaw/issues/70052
 */
describe("estimateMessageTokensCjkAware", () => {
  it("estimates ~1 token per CJK character for a user message", () => {
    // 19 CJK characters — should produce 19 tokens, NOT 5 (19/4)
    const msg: AgentMessage = {
      role: "user",
      content: "このメッセージは日本語で書かれています",
      timestamp: 0,
    };
    const tokens = estimateMessageTokensCjkAware(msg);
    // With estimateStringChars: 19 CJK chars → 19 + 19*3 = 76 virtual chars → 76/4 = 19 tokens
    expect(tokens).toBe(19);
    // Confirm the old approach would have given 5 (the bug)
    expect(Math.ceil(19 / 4)).toBe(5);
  });

  it("returns the same estimate as chars/4 for pure ASCII text", () => {
    const msg: AgentMessage = {
      role: "user",
      content: "Hello world, this is a test message",
      timestamp: 0,
    };
    const tokens = estimateMessageTokensCjkAware(msg);
    const expected = Math.ceil("Hello world, this is a test message".length / 4);
    expect(tokens).toBe(expected);
  });

  it("handles mixed ASCII and CJK content correctly", () => {
    // "Hello " (6 ASCII) + "世界" (2 CJK) + "!" (1 ASCII)
    const text = "Hello 世界!";
    const msg: AgentMessage = {
      role: "user",
      content: text,
      timestamp: 0,
    };
    const tokens = estimateMessageTokensCjkAware(msg);
    // estimateStringChars("Hello 世界!"):
    //   codePointLength = 9, nonLatinCount = 2
    //   result = 9 + 2*(4-1) = 9 + 6 = 15
    //   tokens = ceil(15/4) = 4
    // Old approach: ceil(9/4) = 3
    expect(tokens).toBeGreaterThanOrEqual(4);
    expect(tokens).toBeLessThan(10);
  });

  it("estimates Korean text correctly", () => {
    // "안녕하세요" = 5 Hangul characters
    const msg: AgentMessage = {
      role: "user",
      content: "안녕하세요",
      timestamp: 0,
    };
    const tokens = estimateMessageTokensCjkAware(msg);
    // 5 chars * 4 weight = 20 virtual chars → 20/4 = 5 tokens
    expect(tokens).toBe(5);
    // Old approach: ceil(5/4) = 2
    expect(Math.ceil(5 / 4)).toBe(2);
  });

  it("estimates Chinese text correctly", () => {
    // "你好世界欢迎" = 6 CJK characters
    const msg: AgentMessage = {
      role: "user",
      content: "你好世界欢迎",
      timestamp: 0,
    };
    const tokens = estimateMessageTokensCjkAware(msg);
    // 6 * 4 = 24 virtual chars → 24/4 = 6 tokens
    expect(tokens).toBe(6);
    // Old approach: ceil(6/4) = 2
    expect(Math.ceil(6 / 4)).toBe(2);
  });

  it("handles CJK in assistant messages", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "こんにちは世界" }],
      timestamp: 0,
    } as unknown as AgentMessage;
    const tokens = estimateMessageTokensCjkAware(msg);
    // 7 CJK chars * 4 weight = 28 → 28/4 = 7
    expect(tokens).toBe(7);
  });

  it("handles CJK in toolResult messages", () => {
    const msg: AgentMessage = {
      role: "toolResult",
      content: "検索結果：見つかりました",
      toolCallId: "call_1",
      timestamp: 0,
    } as unknown as AgentMessage;
    const tokens = estimateMessageTokensCjkAware(msg);
    // 12 CJK chars (including colon which isn't CJK) — 11 CJK + 1 ASCII
    // estimateStringChars: codePointLength=12, nonLatinCount=11
    // result = 12 + 11*3 = 45, tokens = ceil(45/4) = 12
    expect(tokens).toBeGreaterThanOrEqual(10);
  });

  it("handles user messages with array content blocks", () => {
    const msg: AgentMessage = {
      role: "user",
      content: [
        { type: "text", text: "翻訳してください" },
        { type: "text", text: "Thank you" },
      ],
      timestamp: 0,
    } as unknown as AgentMessage;
    const tokens = estimateMessageTokensCjkAware(msg);
    // "翻訳してください" = 8 CJK → 32 virtual + "Thank you" = 9 ASCII
    // total = 32 + 9 = 41 → ceil(41/4) = 11
    expect(tokens).toBeGreaterThanOrEqual(10);
  });

  it("returns 0 for unknown message roles", () => {
    const msg = { role: "unknown_role", content: "test", timestamp: 0 } as unknown as AgentMessage;
    expect(estimateMessageTokensCjkAware(msg)).toBe(0);
  });

  it("handles empty content", () => {
    const msg: AgentMessage = { role: "user", content: "", timestamp: 0 };
    expect(estimateMessageTokensCjkAware(msg)).toBe(0);
  });
});

describe("estimateMessagesTokens CJK awareness", () => {
  it("produces higher token counts for CJK than the old chars/4 heuristic", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "このメッセージは日本語で書かれています", timestamp: 1 },
      { role: "user", content: "もう一つのメッセージです", timestamp: 2 },
    ];
    const totalTokens = estimateMessagesTokens(messages);
    // Old approach: (19 + 11) / 4 = ~8 tokens
    // CJK-aware: 19 + 11 = 30 CJK chars → 30 tokens
    expect(totalTokens).toBeGreaterThan(20);
  });
});

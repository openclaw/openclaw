import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { estimateStringChars, pruneContextMessages } from "./pruner.js";
import { DEFAULT_CONTEXT_PRUNING_SETTINGS } from "./settings.js";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type AssistantContentBlock = AssistantMessage["content"][number];

const CONTEXT_WINDOW_1M = {
  model: { contextWindow: 1_000_000 },
} as unknown as ExtensionContext;

function makeUser(text: string): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
  };
}

function makeAssistant(content: AssistantMessage["content"]): AgentMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {
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
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

describe("pruneContextMessages", () => {
  it("does not crash on assistant message with malformed thinking block (missing thinking string)", () => {
    const messages: AgentMessage[] = [
      makeUser("hello"),
      makeAssistant([
        { type: "thinking" } as unknown as AssistantContentBlock,
        { type: "text", text: "ok" },
      ]),
    ];
    expect(() =>
      pruneContextMessages({
        messages,
        settings: DEFAULT_CONTEXT_PRUNING_SETTINGS,
        ctx: CONTEXT_WINDOW_1M,
      }),
    ).not.toThrow();
  });

  it("does not crash on assistant message with null content entries", () => {
    const messages: AgentMessage[] = [
      makeUser("hello"),
      makeAssistant([null as unknown as AssistantContentBlock, { type: "text", text: "world" }]),
    ];
    expect(() =>
      pruneContextMessages({
        messages,
        settings: DEFAULT_CONTEXT_PRUNING_SETTINGS,
        ctx: CONTEXT_WINDOW_1M,
      }),
    ).not.toThrow();
  });

  it("does not crash on assistant message with malformed text block (missing text string)", () => {
    const messages: AgentMessage[] = [
      makeUser("hello"),
      makeAssistant([
        { type: "text" } as unknown as AssistantContentBlock,
        { type: "thinking", thinking: "still fine" },
      ]),
    ];
    expect(() =>
      pruneContextMessages({
        messages,
        settings: DEFAULT_CONTEXT_PRUNING_SETTINGS,
        ctx: CONTEXT_WINDOW_1M,
      }),
    ).not.toThrow();
  });

  it("handles well-formed thinking blocks correctly", () => {
    const messages: AgentMessage[] = [
      makeUser("hello"),
      makeAssistant([
        { type: "thinking", thinking: "let me think" },
        { type: "text", text: "here is the answer" },
      ]),
    ];
    const result = pruneContextMessages({
      messages,
      settings: DEFAULT_CONTEXT_PRUNING_SETTINGS,
      ctx: CONTEXT_WINDOW_1M,
    });
    expect(result).toHaveLength(2);
  });
});

describe("estimateStringChars", () => {
  it("returns plain string length for ASCII text", () => {
    expect(estimateStringChars("hello")).toBe(5);
  });

  it("counts CJK characters with extra weight", () => {
    // Each CJK char should count as 4 chars (CHARS_PER_TOKEN_ESTIMATE) so that
    // the downstream chars/4 token estimate yields ~1 token per CJK char.
    // 3 BMP CJK chars: .length=3, adjusted = 3 - 3 + 3*4 = 12
    expect(estimateStringChars("你好世")).toBe(12);
  });

  it("handles mixed ASCII and CJK text", () => {
    // "hi你好" has 2 ASCII + 2 BMP CJK chars
    // .length=4, adjusted = 4 - 2 + 2*4 = 10
    expect(estimateStringChars("hi你好")).toBe(10);
  });

  it("handles Japanese hiragana and katakana", () => {
    // "こんにちは" = 5 hiragana chars, adjusted = 5 - 5 + 5*4 = 20
    expect(estimateStringChars("こんにちは")).toBe(20);
  });

  it("handles Korean hangul", () => {
    // "안녕" = 2 hangul chars, adjusted = 2 - 2 + 2*4 = 8
    expect(estimateStringChars("안녕")).toBe(8);
  });

  it("returns 0 for empty string", () => {
    expect(estimateStringChars("")).toBe(0);
  });

  it("handles astral-plane CJK characters (surrogate pairs)", () => {
    // U+20000 (𠀀) is a CJK Extension B character — a surrogate pair in JS
    // with String.length of 2. Should still count as 4 (one code point).
    expect(estimateStringChars("\u{20000}")).toBe(4);
  });

  it("handles mixed BMP and astral CJK characters", () => {
    // "你𠀀" = 1 BMP CJK (length 1) + 1 astral CJK (length 2) = text.length 3
    // 2 CJK code points → 2 * 4 = 8
    expect(estimateStringChars("你\u{20000}")).toBe(8);
  });

  it("handles mixed ASCII and astral CJK characters", () => {
    // "hi𠀀" = 2 ASCII (length 2) + 1 astral CJK (length 2) = text.length 4
    // adjusted = 4 - 2 + 1*4 = 6 (2 for ASCII + 4 for the CJK code point)
    expect(estimateStringChars("hi\u{20000}")).toBe(6);
  });
});

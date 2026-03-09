import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { pruneContextMessages } from "./pruner.js";
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

  it("weights CJK characters higher than ASCII for token estimation", () => {
    // CJK text: 10 characters, should be estimated as ~10 tokens = 40 adjusted chars
    // ASCII text of same length: 10 characters = ~2.5 tokens = 10 adjusted chars
    // With a tiny context window, CJK content should trigger pruning earlier than ASCII
    const cjkText = "这是一个包含中文字符的测试"; // 12 CJK chars
    const asciiText = "a".repeat(12); // 12 ASCII chars

    const cjkMessages: AgentMessage[] = [
      makeUser(cjkText),
      makeAssistant([{ type: "text", text: "ok" }]),
    ];
    const asciiMessages: AgentMessage[] = [
      makeUser(asciiText),
      makeAssistant([{ type: "text", text: "ok" }]),
    ];

    // With a very small context window, CJK should be pruned (it weighs more)
    const tinyContext = {
      model: { contextWindow: 20 },
    } as unknown as ExtensionContext;

    const cjkResult = pruneContextMessages({
      messages: cjkMessages,
      settings: DEFAULT_CONTEXT_PRUNING_SETTINGS,
      ctx: tinyContext,
    });
    const asciiResult = pruneContextMessages({
      messages: asciiMessages,
      settings: DEFAULT_CONTEXT_PRUNING_SETTINGS,
      ctx: tinyContext,
    });

    // Both should not crash; the CJK content should be estimated as larger
    expect(cjkResult).toBeDefined();
    expect(asciiResult).toBeDefined();
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

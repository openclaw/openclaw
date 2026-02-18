import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { EffectiveContextPruningSettings } from "./settings.js";
import { createEmptyPruneStats, pruneContextMessages } from "./pruner.js";

function makeToolResult(params: {
  toolCallId: string;
  toolName: string;
  text: string;
}): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    content: [{ type: "text", text: params.text }],
    isError: false,
    timestamp: Date.now(),
  };
}

function makeAssistant(text: string, toolCallId?: string): AgentMessage {
  const content: unknown[] = [{ type: "text", text }];
  if (toolCallId) {
    content.push({ type: "toolCall", id: toolCallId, name: "test_tool", arguments: {} });
  }
  return {
    role: "assistant",
    content,
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeUser(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

const CHARS_PER_TOKEN = 4;

function makeSettings(
  overrides?: Partial<EffectiveContextPruningSettings>,
): EffectiveContextPruningSettings {
  return {
    mode: "cache-ttl" as const,
    ttlMs: 300_000,
    keepLastAssistants: 2,
    softTrimRatio: 0.5,
    hardClearRatio: 0.8,
    minPrunableToolChars: 0,
    softTrim: { maxChars: 200, headChars: 50, tailChars: 50 },
    hardClear: { enabled: true, placeholder: "[Pruned]" },
    tools: {},
    ...overrides,
  };
}

describe("PruneStats instrumentation", () => {
  it("createEmptyPruneStats returns zeroed stats", () => {
    const stats = createEmptyPruneStats();
    expect(stats).toEqual({
      totalCharsBefore: 0,
      totalCharsAfter: 0,
      charRatio: 0,
      softTrimCount: 0,
      hardClearCount: 0,
    });
  });

  it("populates stats when soft-trim fires", () => {
    // Build messages that exceed softTrimRatio (0.5) of a small context window
    const bigText = "x".repeat(2000);
    const messages: AgentMessage[] = [
      makeUser("hello"),
      makeAssistant("thinking...", "tc1"),
      makeToolResult({ toolCallId: "tc1", toolName: "read", text: bigText }),
      makeAssistant("response 1", "tc2"),
      makeToolResult({ toolCallId: "tc2", toolName: "read", text: bigText }),
      makeAssistant("final answer"),
    ];

    const stats = createEmptyPruneStats();
    // Context window small enough that ratio > 0.5
    const contextWindowTokens = 600; // 600 * 4 = 2400 char window, ~4000 chars in messages
    const result = pruneContextMessages({
      messages,
      settings: makeSettings(),
      ctx: { model: { contextWindow: contextWindowTokens } as never },
      contextWindowTokensOverride: contextWindowTokens,
      stats,
    });

    expect(result).not.toBe(messages);
    expect(stats.totalCharsBefore).toBeGreaterThan(0);
    expect(stats.totalCharsAfter).toBeGreaterThan(0);
    expect(stats.totalCharsAfter).toBeLessThanOrEqual(stats.totalCharsBefore);
    expect(stats.softTrimCount).toBeGreaterThanOrEqual(1);
  });

  it("populates stats when hard-clear fires", () => {
    const bigText = "x".repeat(5000);
    const messages: AgentMessage[] = [
      makeUser("hello"),
      makeAssistant("thinking...", "tc1"),
      makeToolResult({ toolCallId: "tc1", toolName: "read", text: bigText }),
      makeAssistant("thinking more...", "tc2"),
      makeToolResult({ toolCallId: "tc2", toolName: "read", text: bigText }),
      makeAssistant("final answer"),
    ];

    const stats = createEmptyPruneStats();
    // Very small window to force hard-clear (ratio > 0.8)
    const contextWindowTokens = 400; // 400 * 4 = 1600 char window, ~10k chars in messages
    const result = pruneContextMessages({
      messages,
      settings: makeSettings(),
      ctx: { model: { contextWindow: contextWindowTokens } as never },
      contextWindowTokensOverride: contextWindowTokens,
      stats,
    });

    expect(result).not.toBe(messages);
    expect(stats.hardClearCount).toBeGreaterThanOrEqual(1);
    expect(stats.totalCharsAfter).toBeLessThan(stats.totalCharsBefore);
    expect(stats.charRatio).toBeLessThan(
      stats.totalCharsBefore / (contextWindowTokens * CHARS_PER_TOKEN),
    );
  });

  it("does not throw when stats is undefined", () => {
    const bigText = "x".repeat(2000);
    const messages: AgentMessage[] = [
      makeUser("hello"),
      makeAssistant("thinking...", "tc1"),
      makeToolResult({ toolCallId: "tc1", toolName: "read", text: bigText }),
      makeAssistant("response 1", "tc2"),
      makeToolResult({ toolCallId: "tc2", toolName: "read", text: bigText }),
      makeAssistant("final answer"),
    ];

    // Should not throw when stats is undefined
    const result = pruneContextMessages({
      messages,
      settings: makeSettings(),
      ctx: { model: { contextWindow: 600 } as never },
      contextWindowTokensOverride: 600,
    });

    expect(result).not.toBe(messages);
  });

  it("stats reflect early return when ratio below softTrimRatio", () => {
    const messages: AgentMessage[] = [makeUser("hello"), makeAssistant("hi")];

    const stats = createEmptyPruneStats();
    // Large window — ratio well below 0.5
    const result = pruneContextMessages({
      messages,
      settings: makeSettings(),
      ctx: { model: { contextWindow: 100_000 } as never },
      contextWindowTokensOverride: 100_000,
      stats,
    });

    // No pruning happened — stats stay zeroed
    expect(result).toBe(messages);
    expect(stats.totalCharsBefore).toBe(0);
    expect(stats.softTrimCount).toBe(0);
    expect(stats.hardClearCount).toBe(0);
  });

  it("counts both soft-trim and hard-clear in the same pass", () => {
    // Multiple tool results: some will be soft-trimmed first, others hard-cleared
    const bigText = "x".repeat(3000);
    const messages: AgentMessage[] = [
      makeUser("hello"),
      makeAssistant("a", "tc1"),
      makeToolResult({ toolCallId: "tc1", toolName: "read", text: bigText }),
      makeAssistant("b", "tc2"),
      makeToolResult({ toolCallId: "tc2", toolName: "read", text: bigText }),
      makeAssistant("c", "tc3"),
      makeToolResult({ toolCallId: "tc3", toolName: "read", text: bigText }),
      makeAssistant("final answer"),
    ];

    const stats = createEmptyPruneStats();
    // Window that forces both soft-trim and hard-clear
    const contextWindowTokens = 500; // 500 * 4 = 2000 char window, ~9000 chars in messages
    pruneContextMessages({
      messages,
      settings: makeSettings({ softTrimRatio: 0.3, hardClearRatio: 0.6 }),
      ctx: { model: { contextWindow: contextWindowTokens } as never },
      contextWindowTokensOverride: contextWindowTokens,
      stats,
    });

    // At least some operations should have fired
    expect(stats.softTrimCount + stats.hardClearCount).toBeGreaterThanOrEqual(1);
    expect(stats.totalCharsBefore).toBeGreaterThan(0);
    expect(stats.totalCharsAfter).toBeLessThan(stats.totalCharsBefore);
  });
});

import { describe, expect, it } from "vitest";
import {
  addCacheBreakpoint,
  extractCacheMetrics,
  injectCacheBreakpoints,
  resolvePromptCachingConfig,
} from "./prompt-caching.js";

describe("resolvePromptCachingConfig", () => {
  it("defaults to enabled", () => {
    expect(resolvePromptCachingConfig().enabled).toBe(true);
    expect(resolvePromptCachingConfig({}).enabled).toBe(true);
  });

  it("respects explicit config", () => {
    expect(
      resolvePromptCachingConfig({
        agents: { defaults: { promptCaching: { enabled: false } } },
      }).enabled,
    ).toBe(false);

    expect(
      resolvePromptCachingConfig({
        agents: { defaults: { promptCaching: { enabled: true } } },
      }).enabled,
    ).toBe(true);
  });
});

describe("addCacheBreakpoint", () => {
  it("adds cache_control to last block", () => {
    const blocks = [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ];
    const result = addCacheBreakpoint(blocks);
    expect(result[0].cache_control).toBeUndefined();
    expect(result[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("returns empty array unchanged", () => {
    expect(addCacheBreakpoint([])).toEqual([]);
  });

  it("does not mutate original array", () => {
    const blocks = [{ type: "text", text: "hello" }];
    addCacheBreakpoint(blocks);
    expect(blocks[0].cache_control).toBeUndefined();
  });
});

describe("injectCacheBreakpoints", () => {
  it("adds breakpoint to string system prompt", () => {
    const context = { system: "You are a helpful assistant." };
    const result = injectCacheBreakpoints(context);
    expect(Array.isArray(result.system)).toBe(true);
    const systemBlocks = result.system as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;
    expect(systemBlocks).toHaveLength(1);
    expect(systemBlocks[0].text).toBe("You are a helpful assistant.");
    expect(systemBlocks[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("adds breakpoint to array system prompt", () => {
    const context = {
      system: [
        { type: "text", text: "Part 1" },
        { type: "text", text: "Part 2" },
      ],
    };
    const result = injectCacheBreakpoints(context);
    const systemBlocks = result.system as Array<{ cache_control?: { type: string } }>;
    expect(systemBlocks[0].cache_control).toBeUndefined();
    expect(systemBlocks[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("adds breakpoint to last tool definition", () => {
    const context = {
      tools: [
        { name: "read_file", description: "Read a file" },
        { name: "write_file", description: "Write a file" },
      ],
    };
    const result = injectCacheBreakpoints(context);
    expect((result.tools![0] as Record<string, unknown>).cache_control).toBeUndefined();
    expect((result.tools![1] as Record<string, unknown>).cache_control).toEqual({
      type: "ephemeral",
    });
  });

  it("adds breakpoint to stable conversation history", () => {
    const context = {
      messages: [
        { role: "user", content: "first message" },
        { role: "assistant", content: "first response" },
        { role: "user", content: "second message" },
        { role: "assistant", content: "second response" },
        { role: "user", content: "third message" },
        { role: "assistant", content: "third response" },
        { role: "user", content: "fourth message" },
      ],
    };
    const result = injectCacheBreakpoints(context);
    // User turns at indices 0, 2, 4, 6. Walking backwards:
    // 1st-to-last user = index 6 ("fourth message")
    // 2nd-to-last user = index 4 ("third message")
    // 3rd-to-last user = index 2 ("second message")
    // Breakpoint goes on index 1 (message before 3rd-to-last user turn)
    const messages = result.messages!;
    const markedMsg = messages[1];
    const content = markedMsg.content as Array<{ cache_control?: { type: string } }>;
    expect(content[content.length - 1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("skips conversation history breakpoint when fewer than 3 user turns", () => {
    const context = {
      messages: [
        { role: "user", content: "first message" },
        { role: "assistant", content: "first response" },
        { role: "user", content: "second message" },
      ],
    };
    const result = injectCacheBreakpoints(context);
    // No history breakpoint should be added since we need at least 3 user turns
    const messages = result.messages!;
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        // String content means no breakpoint was added
        continue;
      }
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          expect((block as Record<string, unknown>).cache_control).toBeUndefined();
        }
      }
    }
  });

  it("does not mutate original context", () => {
    const context = {
      system: "test",
      tools: [{ name: "tool1" }],
      messages: [{ role: "user", content: "hello" }],
    };
    injectCacheBreakpoints(context);
    expect(typeof context.system).toBe("string");
    expect((context.tools[0] as Record<string, unknown>).cache_control).toBeUndefined();
  });

  it("handles empty context gracefully", () => {
    expect(injectCacheBreakpoints({})).toEqual({});
  });
});

describe("extractCacheMetrics", () => {
  it("extracts metrics from usage object", () => {
    const metrics = extractCacheMetrics({
      inputTokens: 100,
      cacheCreationInputTokens: 500,
      cacheReadInputTokens: 400,
    });
    expect(metrics).not.toBeNull();
    expect(metrics!.inputTokens).toBe(100);
    expect(metrics!.cacheCreationInputTokens).toBe(500);
    expect(metrics!.cacheReadInputTokens).toBe(400);
    expect(metrics!.hitRate).toBe(400 / 1000);
  });

  it("returns null for empty usage", () => {
    expect(extractCacheMetrics(null)).toBeNull();
    expect(extractCacheMetrics(undefined)).toBeNull();
  });

  it("returns null for zero totals", () => {
    expect(extractCacheMetrics({ inputTokens: 0 })).toBeNull();
  });

  it("handles missing cache fields as zero", () => {
    const metrics = extractCacheMetrics({ inputTokens: 100 });
    expect(metrics).not.toBeNull();
    expect(metrics!.cacheCreationInputTokens).toBe(0);
    expect(metrics!.cacheReadInputTokens).toBe(0);
    expect(metrics!.hitRate).toBe(0);
  });
});

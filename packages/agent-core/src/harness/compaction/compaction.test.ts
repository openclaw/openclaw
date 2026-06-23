import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../../llm.js";
import type { AssistantMessage, Model, StreamFn } from "../../llm.js";
import { compact, generateSummary } from "./compaction.js";

describe("generateSummary thinking options", () => {
  it("maps explicit Fable off to low effort for compaction", async () => {
    const model: Model = {
      id: "production-fable",
      name: "Production Fable",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      params: { canonicalModelId: "claude-fable-5" },
    };
    const summaryMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "summary" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    };
    const streamFn = vi.fn<StreamFn>((_model, _context, options) => {
      expect(options?.reasoning).toBe("low");
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: summaryMessage });
      stream.end();
      return stream;
    });

    const result = await generateSummary(
      [{ role: "user", content: "hello", timestamp: 1 }],
      model,
      1000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "off",
      streamFn,
    );

    expect(result).toEqual({ ok: true, value: "summary" });
    expect(streamFn).toHaveBeenCalledOnce();
  });
});

describe("compact empty-content guard", () => {
  it("skips summarization when messages have no meaningful content", async () => {
    const model: Model = {
      id: "test-model",
      name: "Test Model",
      api: "openai-chat",
      provider: "openai",
      baseUrl: "https://api.openai.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4096,
      params: {},
    };

    const preparation = {
      firstKeptEntryId: "test-id",
      messagesToSummarize: [
        { role: "assistant", content: [{ type: "text", text: "" }], timestamp: 1 },
      ],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 100,
      previousSummary: undefined,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    };

    const result = await compact(preparation, model, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.summary).toBe("No prior history.");
    }
  });

  it("proceeds with summarization when user message has content", async () => {
    const model: Model = {
      id: "test-model",
      name: "Test Model",
      api: "openai-chat",
      provider: "openai",
      baseUrl: "https://api.openai.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4096,
      params: {},
    };

    const summaryMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "compacted summary" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    };

    const streamFn = vi.fn<StreamFn>((_model, _context, _options) => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: summaryMessage });
      stream.end();
      return stream;
    });

    const preparation = {
      firstKeptEntryId: "test-id",
      messagesToSummarize: [{ role: "user", content: "hello", timestamp: 1 }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 100,
      previousSummary: undefined,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    };

    const result = await compact(
      preparation,
      model,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      streamFn,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.summary).toContain("compacted summary");
    }
    expect(streamFn).toHaveBeenCalledOnce();
  });
});

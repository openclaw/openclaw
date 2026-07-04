import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../../llm.js";
import type { AssistantMessage, Model, StreamFn, Usage } from "../../llm.js";
import { calculateContextTokens, generateSummary } from "./compaction.js";

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

function makeUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}

describe("calculateContextTokens", () => {
  it("returns totalTokens when non-zero", () => {
    const usage = makeUsage({ totalTokens: 163_978 });
    expect(calculateContextTokens(usage)).toBe(163_978);
  });

  it("returns totalTokens even when other fields are large (prefers totalTokens)", () => {
    const usage = makeUsage({
      input: 1000,
      output: 500,
      cacheRead: 999_999,
      cacheWrite: 500_000,
      totalTokens: 1_500,
    });
    expect(calculateContextTokens(usage)).toBe(1_500);
  });

  it("falls back to input + output + cacheRead + cacheWrite when totalTokens is 0", () => {
    const usage = makeUsage({ input: 100, output: 200, totalTokens: 0 });
    expect(calculateContextTokens(usage)).toBe(300);
  });

  it("includes cacheRead/cacheWrite in fallback for single-call cached usage", () => {
    // A single API call with prompt caching: totalTokens is 0 on the usage,
    // but cacheRead/cacheWrite represent real context tokens for this call.
    // The fallback must include them to avoid undercounting context (#99843).
    const usage = makeUsage({
      input: 50,
      output: 200,
      cacheRead: 150_000,
      cacheWrite: 10_000,
      totalTokens: 0,
    });
    expect(calculateContextTokens(usage)).toBe(160_250);
  });

  it("returns 0 when all fields are 0", () => {
    const usage = makeUsage();
    expect(calculateContextTokens(usage)).toBe(0);
  });
});

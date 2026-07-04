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

  it("falls back to input + output when totalTokens is 0", () => {
    const usage = makeUsage({ input: 12, output: 15_104, totalTokens: 0 });
    expect(calculateContextTokens(usage)).toBe(15_116);
  });

  it("excludes turn-aggregated cacheRead/cacheWrite from fallback (regression #99843)", () => {
    // Simulates the exact scenario from #99843: a multi-call tool-loop turn
    // where cacheRead is aggregated across ~12 API calls but totalTokens is
    // missing (0). The fallback must not sum cacheRead/cacheWrite, or it
    // would report 927,907 instead of the correct ~15,116.
    const usage = makeUsage({
      input: 12,
      output: 15_104,
      cacheRead: 819_661,
      cacheWrite: 93_130,
      totalTokens: 0,
    });
    const result = calculateContextTokens(usage);
    // Must NOT include cacheRead/cacheWrite in the fallback.
    expect(result).toBe(15_116);
    // Must be far below the inflated sum that the old formula produced.
    expect(result).toBeLessThan(100_000);
  });

  it("returns 0 when all fields are 0", () => {
    const usage = makeUsage();
    expect(calculateContextTokens(usage)).toBe(0);
  });

  it("returns totalTokens even when other fields are large", () => {
    const usage = makeUsage({
      input: 1000,
      output: 500,
      cacheRead: 999_999,
      cacheWrite: 500_000,
      totalTokens: 1_500,
    });
    expect(calculateContextTokens(usage)).toBe(1_500);
  });
});

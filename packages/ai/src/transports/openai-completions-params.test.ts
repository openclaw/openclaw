import { describe, expect, it, vi } from "vitest";
import { getAiTransportHost } from "../host.js";
import { FAILED_ASSISTANT_REPLAY_TEXT } from "../replay-turn-classification.js";
import type { Model } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import { makeCompletionsModel } from "./openai-completions.test-support.js";

function emptyContext(systemPrompt: string | undefined = "system") {
  return { systemPrompt, messages: [], tools: [] } as never;
}

describe("openai completions params", () => {
  it("uses model params max_completion_tokens for OpenAI completions before model maxTokens", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        api: "openai-completions",
        provider: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262_144,
        maxTokens: 32_000,
        params: {
          max_completion_tokens: 64_000,
        },
      } as never,
      emptyContext(),
      undefined,
    );

    expect(params.max_completion_tokens).toBe(64_000);
    expect(params).not.toHaveProperty("max_tokens");
  });

  it("keeps runtime maxTokens ahead of model params max_completion_tokens for OpenAI completions", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        api: "openai-completions",
        provider: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262_144,
        maxTokens: 32_000,
        params: {
          max_completion_tokens: 64_000,
        },
      } as never,
      emptyContext(),
      { maxTokens: 16_000 } as never,
    );

    expect(params.max_completion_tokens).toBe(16_000);
    expect(params).not.toHaveProperty("max_tokens");
  });

  it("clamps runtime maxTokens to the OpenAI completions model output cap", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "mimo-v2.5-pro",
        name: "MiMo V2.5 Pro",
        provider: "xiaomi-token-plan",
        baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
        maxTokens: 32_000,
      }),
      emptyContext(),
      { maxTokens: 200_000 } as never,
    );

    expect(params.max_completion_tokens).toBe(32_000);
    expect(params).not.toHaveProperty("max_tokens");
  });

  it("keeps zero runtime maxTokens falling back to model params for OpenAI completions", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        api: "openai-completions",
        provider: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262_144,
        maxTokens: 32_000,
        params: {
          max_completion_tokens: 64_000,
        },
      } as never,
      emptyContext(),
      { maxTokens: 0 } as never,
    );

    expect(params.max_completion_tokens).toBe(64_000);
    expect(params).not.toHaveProperty("max_tokens");
  });

  it("uses model maxTokens with max_tokens completions compat when runtime maxTokens is omitted", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "zai-org/GLM-4.7-TEE",
        name: "GLM 4.7 TEE",
        api: "openai-completions",
        provider: "chutes",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 65_536,
      } as never,
      emptyContext(),
      undefined,
    );

    expect(params.max_tokens).toBe(65_536);
    expect(params).not.toHaveProperty("max_completion_tokens");
  });

  it("clamps max_completion_tokens to the remaining context budget for proxy-like endpoints when prompt + output would exceed contextWindow (covers #83086)", () => {
    // StepFun-style shape: large context window, max_tokens equal to context,
    // and a substantial prompt that should leave well under the context budget.
    // 200_000 ASCII chars -> estimated 62_500 input tokens (chars/4 * 1.25).
    // That leaves remaining budget of 262_144 - 62_500 - 1 = 199_643 tokens.
    const systemPrompt = "x".repeat(200_000);
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "step-router-v1",
        name: "StepFun step-router-v1",
        provider: "stepfun-plan",
        baseUrl: "https://api.stepfun.com/v1",
        reasoning: false,
        contextWindow: 262_144,
        maxTokens: 262_144,
      }),
      emptyContext(systemPrompt),
      undefined,
    );

    expect(typeof params.max_completion_tokens).toBe("number");
    const cap = params.max_completion_tokens as number;
    const estimatedInputTokens = Math.ceil((systemPrompt.length / 4) * 1.25);
    expect(cap).toBe(262_144 - estimatedInputTokens - 1);
    expect(cap).toBeLessThan(262_144);
  });

  it("uses CJK-aware input estimates when clamping proxy-like completions output budgets", () => {
    const cjkPrompt = "你好世界".repeat(1_000);
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        provider: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        reasoning: false,
        contextWindow: 10_000,
        maxTokens: 10_000,
      }),
      {
        systemPrompt: cjkPrompt,
        messages: [],
        tools: [],
      } as never,
      undefined,
    );

    // 4,000 CJK chars count as 16,000 adjusted chars, then chars/4 * 1.25.
    expect(params.max_completion_tokens).toBe(10_000 - 5_000 - 1);
  });

  it("rounds proxy-like completions input estimates after summing message content", () => {
    const messages = Array.from({ length: 4_000 }, () => ({
      role: "user",
      content: "x",
    }));
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "qwen3-5-122b-a10b-nvfp4",
        name: "qwen3-5-122b-a10b-nvfp4",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
        reasoning: false,
        contextWindow: 10_000,
        maxTokens: 10_000,
      }),
      {
        systemPrompt: undefined,
        messages,
        tools: [],
      } as never,
      undefined,
    );

    expect(params.max_completion_tokens).toBe(10_000 - 1_250 - 1);
  });

  it("estimates proxy-like completions input from the final outbound messages after compat transforms", () => {
    const userText = "ok";
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "qwen3-5-122b-a10b-nvfp4",
        name: "qwen3-5-122b-a10b-nvfp4",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
        reasoning: false,
        contextWindow: 10_000,
        maxTokens: 10_000,
      }),
      {
        messages: [
          { role: "user", content: userText, timestamp: 1 },
          {
            role: "assistant",
            content: [{ type: "text", text: "x".repeat(20_000) }],
            api: "openai-completions",
            provider: "vllm",
            model: "qwen3-5-122b-a10b-nvfp4",
            usage: createZeroUsage(),
            stopReason: "aborted",
            timestamp: 2,
          },
        ],
        tools: [],
      } as never,
      undefined,
    );

    // The aborted turn replays as a short marker, so its 20,000 characters stay out of
    // the estimate while the turn itself stays visible to the model.
    const estimatedInputTokens = Math.ceil(
      ((userText.length + FAILED_ASSISTANT_REPLAY_TEXT.length) / 4) * 1.25,
    );
    expect(params.max_completion_tokens).toBe(10_000 - estimatedInputTokens - 1);
  });

  it("clamps proxy-like completions output budgets against contextTokens before contextWindow", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "qwen3-5-122b-a10b-nvfp4",
        name: "qwen3-5-122b-a10b-nvfp4",
        api: "openai-completions",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131_072,
        contextTokens: 4_096,
        maxTokens: 200_000,
      } as unknown as Model<"openai-completions">,
      emptyContext(),
      undefined,
    );

    expect(params.max_completion_tokens).toBe(4_096 - 2 - 1);
  });

  it.each([0, 1, 15])(
    "rejects a reasoning proxy request with only %i output tokens left",
    (remaining) => {
      const model = makeCompletionsModel({
        baseUrl: "http://localhost:8000/v1",
        reasoning: true,
        contextWindow: 1000,
        maxTokens: 1000,
      });
      // 3,200 ASCII characters estimate to 1,000 input tokens.
      expect(() =>
        buildOpenAICompletionsParams(
          { ...model, contextTokens: 1001 + remaining },
          emptyContext("x".repeat(3200)),
          undefined,
        ),
      ).toThrowError(expect.objectContaining({ code: "context_length_exceeded" }));
    },
  );

  it.each([
    ["non-reasoning", false, undefined],
    ["thinking-off", true, { reasoning: "off" }],
  ] as const)(
    "never sends a %s proxy request a context-reduced cap under the useful floor",
    (_mode, reasoning, options) => {
      const model = makeCompletionsModel({
        baseUrl: "http://localhost:8000/v1",
        reasoning,
        contextWindow: 1000,
        maxTokens: 1000,
      });
      const capAt = (chars: number): number | "refused" => {
        try {
          return buildOpenAICompletionsParams(model, emptyContext("x".repeat(chars)), options)
            .max_completion_tokens as number;
        } catch (error) {
          expect(error).toMatchObject({ code: "context_length_exceeded" });
          return "refused";
        }
      };
      // The margined estimate leaves 16 tokens at 3,145 characters and 15 at 3,146, where the
      // budget moves to the unmargined estimate; that leaves 16 at 3,932 and 15 at 3,933, where
      // the request is refused.
      expect(capAt(3100)).toBe(30);
      expect(capAt(3145)).toBe(16);
      expect(capAt(3146)).toBe(212);
      expect(capAt(3932)).toBe(16);
      expect(capAt(3933)).toBe("refused");
      // Sweep from a margined budget through the unmargined band to exhaustion.
      const caps = Array.from({ length: 1101 }, (_, index) => capAt(3000 + index));
      const sent = caps.filter((cap): cap is number => cap !== "refused");
      expect(Math.min(...sent)).toBeGreaterThanOrEqual(16);
      const firstRefusal = caps.indexOf("refused");
      expect(caps.slice(firstRefusal).every((cap) => cap === "refused")).toBe(true);
      // The cap grows only once, where the budget moves to the unmargined estimate.
      const increases = sent.filter((cap, index) => cap > (sent[index - 1] ?? cap));
      expect(increases).toHaveLength(1);
    },
  );

  it.each([
    ["non-reasoning", false, undefined],
    ["thinking-off", true, { reasoning: "off" }],
  ] as const)(
    "rejects a %s proxy request with no output tokens left without the margin",
    (_mode, reasoning, options) => {
      const model = makeCompletionsModel({
        baseUrl: "http://localhost:8000/v1",
        reasoning,
        contextWindow: 1000,
        maxTokens: 1000,
      });
      // 4,000 ASCII characters estimate to 1,250 input tokens, or 1,000 without the margin.
      const context = emptyContext("x".repeat(4000));
      for (const remaining of [-1, 0]) {
        expect(() =>
          buildOpenAICompletionsParams(
            { ...model, contextTokens: 1001 + remaining },
            context,
            options,
          ),
        ).toThrowError(expect.objectContaining({ code: "context_length_exceeded" }));
      }
      expect(() =>
        buildOpenAICompletionsParams({ ...model, contextTokens: 1000 }, context, options),
      ).toThrowError(
        "Context window exceeded: estimated input 1000 tokens (without the 1.25x estimate margin) " +
          "leaves 0 of the 16 output tokens a reply needs within the 1000-token context.",
      );
      // A requested cap of 1 is always sent, even past the context; the provider rejects it then.
      expect(
        buildOpenAICompletionsParams({ ...model, contextTokens: 1000 }, context, {
          ...options,
          maxTokens: 1,
        }).max_completion_tokens,
      ).toBe(1);
      // Caller-owned short budgets that fit the unmargined room go out unchanged; 3,600
      // characters leave 99 tokens without the margin and none with it.
      for (const maxTokens of [1, 2, 16]) {
        expect(
          buildOpenAICompletionsParams(
            { ...model, contextTokens: 1000 },
            emptyContext("x".repeat(3600)),
            { ...options, maxTokens },
          ).max_completion_tokens,
        ).toBe(maxTokens);
      }
    },
  );

  it.each([
    ["non-reasoning", false, undefined, 199],
    ["thinking-off", true, { reasoning: "off" }, 199],
    ["thinking-enabled", true, undefined, undefined],
  ] as const)(
    "handles a %s proxy request between the unmargined and margined estimates",
    (_mode, reasoning, options, expected) => {
      const model = makeCompletionsModel({
        baseUrl: "http://localhost:8000/v1",
        reasoning,
        contextWindow: 1000,
        contextTokens: 1000,
        maxTokens: 1000,
      });
      // 3,200 ASCII characters estimate to 1,000 input tokens, or 800 without the margin.
      const build = () =>
        buildOpenAICompletionsParams(model, emptyContext("x".repeat(3200)), options);
      if (expected === undefined) {
        expect(build).toThrowError(expect.objectContaining({ code: "context_length_exceeded" }));
        expect(build).toThrowError(
          "Context window exceeded: estimated input 1000 tokens (with the 1.25x estimate margin) " +
            "leaves 0 of the 16 output tokens a reply needs within the 1000-token context.",
        );
      } else {
        expect(build().max_completion_tokens).toBe(expected);
      }
    },
  );

  it("warns when a proxy request is budgeted from the unmargined estimate", () => {
    const model = makeCompletionsModel({
      baseUrl: "http://localhost:8000/v1",
      reasoning: false,
      contextWindow: 1000,
      maxTokens: 1000,
    });
    const warning = vi.spyOn(getAiTransportHost(), "logWarn");
    try {
      buildOpenAICompletionsParams(model, emptyContext("x".repeat(3100)), undefined);
      expect(warning).not.toHaveBeenCalled();
      buildOpenAICompletionsParams(model, emptyContext("x".repeat(3200)), undefined);
      expect(warning).toHaveBeenCalledWith(
        "openai-transport",
        expect.stringContaining(
          "output=199 effectiveContext=1000 estimatedInput=800 estimate=unmargined marginedInput=1000",
        ),
        undefined,
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("preserves useful clamping and intentionally short completions", () => {
    const model = makeCompletionsModel({
      baseUrl: "http://localhost:8000/v1",
      contextWindow: 1017,
      maxTokens: 1000,
    });
    const context = emptyContext("x".repeat(3200));
    expect(buildOpenAICompletionsParams(model, context, undefined).max_completion_tokens).toBe(16);
    // With thinking enabled too, a requested cap of 1 is sent even when the estimate is past the context.
    expect(
      buildOpenAICompletionsParams(
        { ...model, contextWindow: 1000 },
        emptyContext("x".repeat(8000)),
        { maxTokens: 1 },
      ).max_completion_tokens,
    ).toBe(1);
    expect(
      buildOpenAICompletionsParams(model, context, { maxTokens: 1 }).max_completion_tokens,
    ).toBe(1);
  });

  it("clamps max_completion_tokens for proxy-like endpoints when configured maxTokens >= contextWindow and prompt is small", () => {
    // Misconfig case: tiny prompt, but configured maxTokens still exceeds the
    // model's contextWindow. Clamp should land just under the window.
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "qwen3-5-122b-a10b-nvfp4",
        name: "qwen3-5-122b-a10b-nvfp4",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
        reasoning: false,
        contextWindow: 131_072,
        maxTokens: 200_000,
      }),
      emptyContext(),
      undefined,
    );

    expect(typeof params.max_completion_tokens).toBe("number");
    const cap = params.max_completion_tokens as number;
    expect(cap).toBeLessThan(131_072);
    // Small prompt → cap is essentially contextWindow - 1 - tiny_input_estimate.
    expect(cap).toBeGreaterThanOrEqual(131_000);
  });

  it("does not clamp max_completion_tokens for proxy-like endpoints when maxTokens fits the context window", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "qwen3-5-122b-a10b-nvfp4",
        name: "qwen3-5-122b-a10b-nvfp4",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
        reasoning: false,
        contextWindow: 131_072,
      }),
      emptyContext(),
      undefined,
    );

    expect(params.max_completion_tokens).toBe(8192);
  });

  it("preserves the configured maxTokens for native openai-completions endpoints even when it equals or exceeds contextWindow", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        reasoning: false,
        contextWindow: 100_000,
        maxTokens: 200_000,
      }),
      emptyContext(),
      undefined,
    );

    expect(params.max_completion_tokens).toBe(200_000);
  });
});

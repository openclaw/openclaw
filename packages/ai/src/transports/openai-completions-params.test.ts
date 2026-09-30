import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { describe, expect, it } from "vitest";
import { FAILED_ASSISTANT_REPLAY_TEXT } from "../replay-turn-classification.js";
import type { Context } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import { makeCompletionsModel } from "./openai-completions.test-support.js";
import { buildOpenAIResponsesParams } from "./openai-responses-params-internal.js";

const native = makeCompletionsModel({ id: "gpt-5.4" });
const proxy = makeCompletionsModel({
  provider: "vllm",
  baseUrl: "http://localhost:8000/v1",
  reasoning: false,
  contextWindow: 10_000,
  maxTokens: 10_000,
});
function emptyContext(systemPrompt = "system"): Context {
  return { systemPrompt, messages: [], tools: [] };
}

function toolContext(): Context {
  return {
    ...emptyContext(),
    tools: [
      {
        name: "lookup_weather",
        description: "Get forecast",
        parameters: { type: "object", properties: {} },
      },
    ],
  };
}

describe("OpenAI completions output budgets", () => {
  it("falls back from zero runtime tokens to model params before the model cap", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "kimi-k2.6",
        provider: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        maxTokens: 32_000,
        params: { max_completion_tokens: 64_000 },
      }),
      emptyContext(),
      { maxTokens: 0 },
    );
    expect(params.max_completion_tokens).toBe(64_000);
    expect(params).not.toHaveProperty("max_tokens");
  });

  it("prioritizes runtime tokens over model params and clamps to the output cap", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "mimo-v2.5-pro",
        provider: "xiaomi-token-plan",
        baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
        maxTokens: 32_000,
        params: { max_completion_tokens: 64_000 },
      }),
      emptyContext(),
      { maxTokens: 200_000 },
    );
    expect(params.max_completion_tokens).toBe(32_000);
    expect(params).not.toHaveProperty("max_tokens");
  });

  it("uses the model cap with max_tokens on the Chutes default route", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({ provider: "chutes", baseUrl: "", maxTokens: 65_536 }),
      emptyContext(),
      undefined,
    );
    expect(params.max_tokens).toBe(65_536);
    expect(params).not.toHaveProperty("max_completion_tokens");
  });

  it("uses CJK-aware input estimates and the effective context cap", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        ...proxy,
        id: "kimi-k2.6",
        provider: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        contextWindow: 20_000,
        contextTokens: 10_000,
      }),
      emptyContext("你好世界".repeat(1_000)),
      undefined,
    );
    expect(params.max_completion_tokens).toBe(4_999);
  });

  it("rounds input estimates after summing message content", () => {
    const params = buildOpenAICompletionsParams(
      proxy,
      {
        messages: Array.from({ length: 4_000 }, () => ({
          role: "user",
          content: "x",
          timestamp: 1,
        })),
        tools: [],
      },
      undefined,
    );
    expect(params.max_completion_tokens).toBe(8_749);
  });

  it("estimates the final replay marker instead of the aborted assistant text", () => {
    const params = buildOpenAICompletionsParams(
      proxy,
      {
        messages: [
          { role: "user", content: "ok", timestamp: 1 },
          {
            role: "assistant",
            content: [{ type: "text", text: "x".repeat(20_000) }],
            api: proxy.api,
            provider: proxy.provider,
            model: proxy.id,
            usage: createZeroUsage(),
            stopReason: "aborted",
            timestamp: 2,
          },
        ],
        tools: [],
      },
      undefined,
    );
    const inputTokens = Math.ceil(((2 + FAILED_ASSISTANT_REPLAY_TEXT.length) / 4) * 1.25);
    expect(params.max_completion_tokens).toBe(10_000 - inputTokens - 1);
  });

  it("preserves non-reasoning short budgets and the exhausted-budget fallback", () => {
    for (const [remaining, expected] of [
      [-1, 1],
      [15, 15],
    ] as const) {
      const params = buildOpenAICompletionsParams(
        { ...proxy, contextTokens: 1001 + remaining },
        emptyContext("x".repeat(3200)),
        undefined,
      );
      expect(params.max_completion_tokens).toBe(expected);
    }
  });

  it("preserves the useful-output floor and intentionally short completions", () => {
    const model = { ...proxy, reasoning: true, contextWindow: 1017, maxTokens: 1000 };
    const context = emptyContext("x".repeat(3200));
    expect(buildOpenAICompletionsParams(model, context, undefined).max_completion_tokens).toBe(16);
    expect(
      buildOpenAICompletionsParams(model, context, { maxTokens: 1 }).max_completion_tokens,
    ).toBe(1);
  });

  it("omits output-token fields when the resolved model has no cap", () => {
    const model = makeCompletionsModel({
      id: "mimo-v2.5-pro",
      provider: "xiaomi",
      baseUrl: "https://api.xiaomimimo.com/v1",
    });
    Reflect.deleteProperty(model, "maxTokens");
    const params = buildOpenAICompletionsParams(model, emptyContext(), undefined);
    expect(params).not.toHaveProperty("max_completion_tokens");
    expect(params).not.toHaveProperty("max_tokens");
  });
});

describe("OpenAI completions reasoning", () => {
  it("maps minimal shared reasoning to low", () => {
    expect(
      buildOpenAICompletionsParams(native, emptyContext(), { reasoning: "minimal" })
        .reasoning_effort,
    ).toBe("low");
  });

  it("strips the internal cache boundary from system prompts", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({ id: "gpt-4.1", reasoning: false }),
      emptyContext("Stable prefix" + SYSTEM_PROMPT_CACHE_BOUNDARY + "Dynamic suffix"),
      undefined,
    );
    expect(params.messages[0]).toEqual({
      role: "system",
      content: "Stable prefix\nDynamic suffix",
    });
  });

  it.each([
    { id: "gpt-5.4-mini", expected: undefined },
    { id: "gpt-5.6-luna", expected: "none" },
    {
      id: "gpt-5.5",
      provider: "custom-openai",
      baseUrl: "https://models.example.com/v1",
      compat: { supportsReasoningEffort: true },
      expected: "medium",
    },
    {
      id: "prod-spud",
      name: "GPT-5.5 (Azure)",
      provider: "azure-openai",
      baseUrl: "https://example.services.ai.azure.com/openai/v1",
      expected: undefined,
    },
  ])("applies the tool reasoning policy for $id", ({ expected, ...model }) => {
    const params = buildOpenAICompletionsParams(makeCompletionsModel(model), toolContext(), {
      reasoning: "medium",
    });
    expect(params.tools).toHaveLength(1);
    if (expected === undefined) {
      expect(params).not.toHaveProperty("reasoning_effort");
    } else {
      expect(params.reasoning_effort).toBe(expected);
    }
  });

  it("uses provider-native effort mappings for enabled and disabled reasoning", () => {
    const model = makeCompletionsModel({
      id: "qwen/qwen3-32b",
      provider: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["none", "default"],
        reasoningEffortMap: { off: "none", low: "default", medium: "default", high: "default" },
      },
    });
    expect(
      buildOpenAICompletionsParams(model, emptyContext(), { reasoning: "medium" }).reasoning_effort,
    ).toBe("default");
    expect(
      buildOpenAICompletionsParams(model, emptyContext(), { reasoning: "off" }).reasoning_effort,
    ).toBe("none");
  });

  it("maps Qwen binary thinking and rejects exhausted thinking-enabled requests", () => {
    const model = makeCompletionsModel({
      ...proxy,
      id: "qwen3.5-32b",
      provider: "llama-cpp",
      reasoning: true,
      compat: { thinkingFormat: "qwen" },
    });
    const enabled = buildOpenAICompletionsParams(model, emptyContext(), { reasoning: "medium" });
    const disabled = buildOpenAICompletionsParams(model, emptyContext(), { reasoning: "off" });
    expect(enabled.enable_thinking).toBe(true);
    expect(disabled.enable_thinking).toBe(false);
    expect(enabled).not.toHaveProperty("reasoning_effort");
    expect(disabled).not.toHaveProperty("reasoning_effort");

    // Regression #157673: disabled thinking keeps short replies; enabled thinking enters overflow recovery.
    const nearCap = { ...model, contextWindow: 1016 };
    const context = emptyContext("x".repeat(3200));
    expect(buildOpenAICompletionsParams(nearCap, context, { reasoning: "off" })).toMatchObject({
      enable_thinking: false,
      max_completion_tokens: 15,
    });
    expect(() =>
      buildOpenAICompletionsParams(nearCap, context, { reasoning: "medium" }),
    ).toThrowError(expect.objectContaining({ code: "context_length_exceeded" }));
    expect(
      buildOpenAICompletionsParams({ ...nearCap, contextWindow: 1000 }, context, {
        reasoning: "off",
      }),
    ).toMatchObject({ enable_thinking: false, max_completion_tokens: 1 });
  });

  it("maps Qwen chat-template thinking without a scalar effort", () => {
    const params = buildOpenAICompletionsParams(
      { ...proxy, reasoning: true, compat: { thinkingFormat: "qwen-chat-template" } },
      emptyContext(),
      { reasoning: "off" },
    );
    expect(params.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(params).not.toHaveProperty("reasoning_effort");
  });

  it("keeps Together binary thinking aligned with mapped scalar effort", () => {
    const model = makeCompletionsModel({
      id: "moonshotai/Kimi-K2.5",
      provider: "together",
      baseUrl: "https://api.together.xyz/v1",
      maxTokens: 32768,
      compat: { thinkingFormat: "together", supportsReasoningEffort: true },
    });
    const enabled = buildOpenAICompletionsParams(model, emptyContext(), { reasoning: "medium" });
    const disabled = buildOpenAICompletionsParams(model, emptyContext(), { reasoning: "off" });
    expect(enabled).toMatchObject({
      max_tokens: 32768,
      reasoning: { enabled: true },
      reasoning_effort: "medium",
    });
    expect(enabled).not.toHaveProperty("max_completion_tokens");
    expect(disabled.reasoning).toEqual({ enabled: false });
    expect(disabled).not.toHaveProperty("reasoning_effort");
    const mappedOff = buildOpenAICompletionsParams(
      { ...model, compat: { ...model.compat, reasoningEffortMap: { off: "low" } } },
      emptyContext(),
      { reasoning: "off" },
    );
    expect(mappedOff).toMatchObject({ reasoning: { enabled: true }, reasoning_effort: "low" });
  });

  it("omits unsupported disabled reasoning", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "openai/gpt-oss-120b",
        provider: "groq",
        baseUrl: "https://api.groq.com/openai/v1",
        compat: {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["low", "medium", "high"],
        },
      }),
      emptyContext(),
      { reasoning: "off" },
    );
    expect(params).not.toHaveProperty("reasoning_effort");
  });

  it.each([
    { provider: "openrouter", baseUrl: "https://proxy.example.com/v1" },
    { provider: "custom-openrouter", baseUrl: "https://openrouter.ai/api/v1" },
  ])("uses OpenRouter reasoning for $provider at $baseUrl", (route) => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({ ...route, id: "anthropic/claude-sonnet-4" }),
      emptyContext(),
      { reasoningEffort: "high" },
    );
    expect(params.reasoning).toEqual({ effort: "high" });
  });

  it("omits OpenRouter reasoning for a non-reasoning model", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "openrouter/hunter-alpha",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: false,
      }),
      emptyContext(),
      { reasoningEffort: "high" },
    );
    expect(params).not.toHaveProperty("reasoning");
    expect(params).not.toHaveProperty("reasoning_effort");
  });
});

describe("OpenAI request cache policy", () => {
  it.each(["openai-completions", "openai-responses"] as const)(
    "selects native long-retention fields for %s",
    (api) => {
      const build =
        api === "openai-completions" ? buildOpenAICompletionsParams : buildOpenAIResponsesParams;
      for (const [id, lifetime] of [
        ["gpt-5.4-2026-03-05", { prompt_cache_retention: "24h" }],
        ["gpt-5.6-sol", { prompt_cache_options: { ttl: "30m" } }],
        ["gpt-4o", {}],
      ] as const) {
        const params = build(
          { ...makeCompletionsModel({ id }), api },
          { messages: [] },
          {
            sessionId: "session-123",
            cacheRetention: "long",
          },
        );
        expect(params.prompt_cache_key).toBe("session-123");
        expect(params.prompt_cache_retention).toBe(
          "prompt_cache_retention" in lifetime ? lifetime.prompt_cache_retention : undefined,
        );
        expect(params.prompt_cache_options).toEqual(
          "prompt_cache_options" in lifetime ? lifetime.prompt_cache_options : undefined,
        );
      }
    },
  );

  it("omits cache metadata when completions caching is disabled", () => {
    const params = buildOpenAICompletionsParams(native, emptyContext(), {
      sessionId: "session-123",
      promptCacheKey: "cron-cache-key",
      cacheRetention: "none",
    });
    expect(params).not.toHaveProperty("prompt_cache_key");
    expect(params).not.toHaveProperty("prompt_cache_retention");
    expect(params).not.toHaveProperty("prompt_cache_options");
  });

  it("does not give a lookalike OpenAI proxy native Responses cache metadata", () => {
    const params = buildOpenAIResponsesParams(
      { ...native, api: "openai-responses", baseUrl: "https://api.openai.com.proxy.example/v1" },
      { messages: [] },
      { sessionId: "session-123", cacheRetention: "long" },
    );
    expect(params.prompt_cache_key).toBeUndefined();
    expect(params).not.toHaveProperty("prompt_cache_retention");
    expect(params).not.toHaveProperty("prompt_cache_options");
  });

  it("uses an explicit cache key and long retention for an opted-in proxy", () => {
    const params = buildOpenAICompletionsParams(
      { ...proxy, compat: { supportsPromptCacheKey: true } },
      emptyContext(),
      { sessionId: "session-123", promptCacheKey: "cron-cache-key", cacheRetention: "long" },
    );
    expect(params.prompt_cache_key).toBe("cron-cache-key");
    expect(params.prompt_cache_retention).toBe("24h");
    expect(params).not.toHaveProperty("prompt_cache_options");
  });

  it("keeps Mistral cache affinity without unsupported long retention", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "mistral-large-latest",
        provider: "mistral",
        baseUrl: "",
        reasoning: false,
        compat: {
          supportsPromptCacheKey: true,
          supportsLongCacheRetention: false,
          supportsStore: false,
          supportsReasoningEffort: false,
          maxTokensField: "max_tokens",
        },
      }),
      emptyContext(),
      { sessionId: "session-123", cacheRetention: "long" },
    );
    expect(params.prompt_cache_key).toBe("session-123");
    expect(params).not.toHaveProperty("prompt_cache_retention");
    expect(params).not.toHaveProperty("prompt_cache_options");
  });
});

import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { describe, expect, it } from "vitest";
import type { OpenAICompletionsOptions } from "../provider-options.js";
import { FAILED_ASSISTANT_REPLAY_TEXT } from "../replay-turn-classification.js";
import type { Context, Model } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import { makeCompletionsModel } from "./openai-completions.test-support.js";
import { buildOpenAIResponsesParams } from "./openai-responses-params-internal.js";

type CompletionsModel = Model<"openai-completions">;
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
function request(
  model: Partial<CompletionsModel>,
  options?: OpenAICompletionsOptions,
  context = emptyContext(),
) {
  return buildOpenAICompletionsParams(makeCompletionsModel(model), context, options);
}

describe("OpenAI completions output budgets", () => {
  it("resolves runtime, model, and context caps without changing the output field", () => {
    const uncapped = makeCompletionsModel({
      id: "mimo-v2.5-pro",
      provider: "xiaomi",
      baseUrl: "https://api.xiaomimimo.com/v1",
    });
    Reflect.deleteProperty(uncapped, "maxTokens");
    const cases = [
      [
        request(
          {
            id: "kimi-k2.6",
            provider: "dashscope",
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            maxTokens: 32_000,
            params: { max_completion_tokens: 64_000 },
          },
          { maxTokens: 0 },
        ),
        "max_completion_tokens",
        64_000,
      ],
      [
        request(
          {
            id: "mimo-v2.5-pro",
            provider: "xiaomi-token-plan",
            baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
            maxTokens: 32_000,
            params: { max_completion_tokens: 64_000 },
          },
          { maxTokens: 200_000 },
        ),
        "max_completion_tokens",
        32_000,
      ],
      [request({ provider: "chutes", baseUrl: "", maxTokens: 65_536 }), "max_tokens", 65_536],
      [
        request(
          {
            ...proxy,
            id: "kimi-k2.6",
            provider: "dashscope",
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            contextWindow: 20_000,
            contextTokens: 10_000,
          },
          undefined,
          emptyContext("你好世界".repeat(1_000)),
        ),
        "max_completion_tokens",
        4_999,
      ],
      [
        request(proxy, undefined, {
          messages: Array.from({ length: 4_000 }, () => ({
            role: "user",
            content: "x",
            timestamp: 1,
          })),
          tools: [],
        }),
        "max_completion_tokens",
        8_749,
      ],
      [
        buildOpenAICompletionsParams(uncapped, emptyContext(), undefined),
        "max_completion_tokens",
        undefined,
      ],
    ] as const;
    for (const [params, field, expected] of cases) {
      if (expected === undefined) {
        expect(params).not.toHaveProperty(field);
      } else {
        expect(params[field]).toBe(expected);
      }
      expect(params).not.toHaveProperty(
        field === "max_tokens" ? "max_completion_tokens" : "max_tokens",
      );
    }
  });

  it("estimates the final replay marker instead of the aborted assistant text", () => {
    const params = request(proxy, undefined, {
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
    });
    const inputTokens = Math.ceil(((2 + FAILED_ASSISTANT_REPLAY_TEXT.length) / 4) * 1.25);
    expect(params.max_completion_tokens).toBe(10_000 - inputTokens - 1);
  });

  it("preserves short non-reasoning budgets, the useful floor, and intentional short replies", () => {
    const cases: [Partial<CompletionsModel>, OpenAICompletionsOptions | undefined, number][] = [
      [{ ...proxy, contextTokens: 1000 }, undefined, 1],
      [{ ...proxy, contextTokens: 1016 }, undefined, 15],
      [{ ...proxy, reasoning: true, contextWindow: 1017, maxTokens: 1000 }, undefined, 16],
      [{ ...proxy, reasoning: true, contextWindow: 1017, maxTokens: 1000 }, { maxTokens: 1 }, 1],
    ];
    for (const [model, options, expected] of cases) {
      expect(request(model, options, emptyContext("x".repeat(3200))).max_completion_tokens).toBe(
        expected,
      );
    }
  });
});

describe("OpenAI completions reasoning", () => {
  it("maps shared reasoning to supported provider-native efforts", () => {
    const groq = { provider: "groq", baseUrl: "https://api.groq.com/openai/v1" };
    const mapped = makeCompletionsModel({
      ...groq,
      id: "qwen/qwen3-32b",
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["none", "default"],
        reasoningEffortMap: { off: "none", low: "default", medium: "default", high: "default" },
      },
    });
    const cases: [
      Partial<CompletionsModel>,
      OpenAICompletionsOptions["reasoning"],
      string | undefined,
    ][] = [
      [native, "minimal", "low"],
      [mapped, "medium", "default"],
      [mapped, "off", "none"],
      [
        {
          ...groq,
          id: "openai/gpt-oss-120b",
          compat: {
            supportsReasoningEffort: true,
            supportedReasoningEfforts: ["low", "medium", "high"],
          },
        },
        "off",
        undefined,
      ],
    ];
    for (const [model, reasoning, expected] of cases) {
      const params = request(model, { reasoning });
      if (expected === undefined) {
        expect(params).not.toHaveProperty("reasoning_effort");
      } else {
        expect(params.reasoning_effort).toBe(expected);
      }
    }
  });

  it("strips the internal cache boundary from system prompts", () => {
    const params = request(
      { id: "gpt-4.1", reasoning: false },
      undefined,
      emptyContext("Stable prefix" + SYSTEM_PROMPT_CACHE_BOUNDARY + "Dynamic suffix"),
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
      id: "custom-azure-deployment",
      name: "GPT-5.5 (Azure)",
      provider: "azure-openai",
      baseUrl: "https://example.services.ai.azure.com/openai/v1",
      expected: undefined,
    },
  ])("applies the tool reasoning policy for $id", ({ expected, ...model }) => {
    const params = request(model, { reasoning: "medium" }, toolContext());
    expect(params.tools).toHaveLength(1);
    if (expected === undefined) {
      expect(params).not.toHaveProperty("reasoning_effort");
    } else {
      expect(params.reasoning_effort).toBe(expected);
    }
  });

  it("maps Qwen binary thinking and rejects exhausted thinking-enabled requests", () => {
    const model = makeCompletionsModel({
      ...proxy,
      id: "qwen3.5-32b",
      provider: "llama-cpp",
      reasoning: true,
      compat: { thinkingFormat: "qwen" },
    });
    for (const [reasoning, enabled] of [
      ["medium", true],
      ["off", false],
    ] as const) {
      const params = request(model, { reasoning });
      expect(params.enable_thinking).toBe(enabled);
      expect(params).not.toHaveProperty("reasoning_effort");
    }
    // Regression #157673: only enabled thinking enters overflow recovery.
    const nearCap = { ...model, contextWindow: 1016 };
    const context = emptyContext("x".repeat(3200));
    expect(request(nearCap, { reasoning: "off" }, context)).toMatchObject({
      enable_thinking: false,
      max_completion_tokens: 15,
    });
    expect(() => request(nearCap, { reasoning: "medium" }, context)).toThrowError(
      expect.objectContaining({ code: "context_length_exceeded" }),
    );
    expect(
      request({ ...nearCap, contextWindow: 1000 }, { reasoning: "off" }, context),
    ).toMatchObject({ enable_thinking: false, max_completion_tokens: 1 });
  });

  it("maps Qwen chat-template thinking without a scalar effort", () => {
    const params = request(
      { ...proxy, reasoning: true, compat: { thinkingFormat: "qwen-chat-template" } },
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
    const enabled = request(model, { reasoning: "medium" });
    expect(enabled).toMatchObject({
      max_tokens: 32768,
      reasoning: { enabled: true },
      reasoning_effort: "medium",
    });
    expect(enabled).not.toHaveProperty("max_completion_tokens");
    const disabled = request(model, { reasoning: "off" });
    expect(disabled.reasoning).toEqual({ enabled: false });
    expect(disabled).not.toHaveProperty("reasoning_effort");
    expect(
      request(
        { ...model, compat: { ...model.compat, reasoningEffortMap: { off: "low" } } },
        { reasoning: "off" },
      ),
    ).toMatchObject({ reasoning: { enabled: true }, reasoning_effort: "low" });
  });

  it("uses OpenRouter reasoning only for reasoning models on provider and host routes", () => {
    for (const model of [
      {
        provider: "openrouter",
        baseUrl: "https://proxy.example.com/v1",
        id: "anthropic/claude-sonnet-4",
        reasoning: true,
      },
      {
        provider: "custom-openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        id: "anthropic/claude-sonnet-4",
        reasoning: true,
      },
      {
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        id: "openrouter/hunter-alpha",
        reasoning: false,
      },
    ]) {
      const params = request(model, { reasoningEffort: "high" });
      if (model.reasoning) {
        expect(params.reasoning).toEqual({ effort: "high" });
      } else {
        expect(params).not.toHaveProperty("reasoning");
        expect(params).not.toHaveProperty("reasoning_effort");
      }
    }
  });
});

describe("OpenAI request cache policy", () => {
  it.each(["openai-completions", "openai-responses"] as const)(
    "selects native long-retention fields for %s",
    (api) => {
      const build =
        api === "openai-completions" ? buildOpenAICompletionsParams : buildOpenAIResponsesParams;
      for (const [id, retention, options] of [
        ["gpt-5.4-2026-03-05", "24h", undefined],
        ["gpt-5.6-sol", undefined, { ttl: "30m" }],
        ["gpt-4o", undefined, undefined],
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
        expect(params.prompt_cache_retention).toBe(retention);
        expect(params.prompt_cache_options).toEqual(options);
      }
    },
  );

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

  it("honors cache opt-out, explicit proxy keys, and unsupported retention", () => {
    const cases: [
      Partial<CompletionsModel>,
      OpenAICompletionsOptions,
      string | undefined,
      string | undefined,
    ][] = [
      [native, { promptCacheKey: "cron-cache-key", cacheRetention: "none" }, undefined, undefined],
      [
        { ...proxy, compat: { supportsPromptCacheKey: true } },
        { promptCacheKey: "cron-cache-key", cacheRetention: "long" },
        "cron-cache-key",
        "24h",
      ],
      [
        {
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
        },
        { cacheRetention: "long" },
        "session-123",
        undefined,
      ],
    ];
    for (const [model, options, key, retention] of cases) {
      const params = request(model, { sessionId: "session-123", ...options });
      if (key === undefined) {
        expect(params).not.toHaveProperty("prompt_cache_key");
      } else {
        expect(params.prompt_cache_key).toBe(key);
      }
      if (retention === undefined) {
        expect(params).not.toHaveProperty("prompt_cache_retention");
      } else {
        expect(params.prompt_cache_retention).toBe(retention);
      }
      expect(params).not.toHaveProperty("prompt_cache_options");
    }
  });
});

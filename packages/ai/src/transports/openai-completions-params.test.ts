import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { describe, expect, it } from "vitest";
import type { OpenAICompletionsOptions } from "../provider-options.js";
import { FAILED_ASSISTANT_REPLAY_TEXT } from "../replay-turn-classification.js";
import type { Context, Model, Tool } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import { makeCompletionsModel } from "./openai-completions.test-support.js";
import { buildOpenAIResponsesParams } from "./openai-responses-params-internal.js";
import type { OpenAIModeModel } from "./openai-transport-shared.js";

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
function tool(parameters: Record<string, unknown> = { type: "object", properties: {} }): Tool {
  return { name: "lookup_weather", description: "Get forecast", parameters };
}
function toolContext(parameters?: Record<string, unknown>): Context {
  return { ...emptyContext(), tools: [tool(parameters)] };
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
    { id: "gpt-5.6-luna", expected: "none" },
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
  it("preserves native cache metadata in managed completions", () => {
    const params = request(
      { id: "gpt-5.6-sol" },
      { sessionId: "session-123", cacheRetention: "long" },
    );
    expect(params.prompt_cache_key).toBe("session-123");
    expect(params.prompt_cache_options).toEqual({ ttl: "30m" });
    expect(params).not.toHaveProperty("prompt_cache_retention");
  });

  it("selects native long-retention fields for responses", () => {
    const api = "openai-responses";
    const build = buildOpenAIResponsesParams;
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

const nonReasoningNative = makeCompletionsModel({ id: "gpt-5.4", reasoning: false });
const schema = {
  type: "object",
  properties: { reply: { type: "string" } },
  required: ["reply"],
  additionalProperties: false,
};

describe("OpenAI completions sampling and response format", () => {
  it("forwards temperature and top_p", () => {
    const params = buildOpenAICompletionsParams(nonReasoningNative, emptyContext(), {
      temperature: 0.4,
      topP: 0.9,
    });
    expect(params.temperature).toBe(0.4);
    expect(params.top_p).toBe(0.9);
  });

  it("forwards penalties and seed", () => {
    const params = buildOpenAICompletionsParams(nonReasoningNative, emptyContext(), {
      frequencyPenalty: -0.5,
      presencePenalty: 1.25,
      seed: 12345,
    });
    expect(params.frequency_penalty).toBe(-0.5);
    expect(params.presence_penalty).toBe(1.25);
    expect(params.seed).toBe(12345);
  });

  it("forwards stop sequences", () => {
    expect(
      buildOpenAICompletionsParams(nonReasoningNative, emptyContext(), {
        stop: ["User:", "Assistant:"],
      }).stop,
    ).toEqual(["User:", "Assistant:"]);
  });

  it("infers JSON Schema support from model families and snapshot boundaries", () => {
    const build = (id: string) =>
      buildOpenAICompletionsParams(makeCompletionsModel({ id, reasoning: false }), emptyContext(), {
        responseFormat: schema,
      });
    for (const id of ["gpt-4o-audio-preview", "gpt-4o-2024-05-13"]) {
      expect(build(id)).not.toHaveProperty("response_format");
    }
    for (const id of ["gpt-4o", "gpt-4o-2024-08-06", "gpt-4o-mini-2024-07-18", "gpt-4.1", "o1"]) {
      expect(build(id).response_format).toMatchObject({ type: "json_schema" });
    }
  });

  it("requires backend support for bare schemas but preserves explicitly configured formats", () => {
    const model = { ...proxy, compat: { supportsJsonSchemaResponseFormat: false } };
    expect(
      buildOpenAICompletionsParams(model, emptyContext(), { responseFormat: schema }),
    ).not.toHaveProperty("response_format");
    const configured = { type: "json_schema", json_schema: { name: "configured", schema } };
    expect(
      buildOpenAICompletionsParams(model, emptyContext(), { responseFormat: configured })
        .response_format,
    ).toBe(configured);
  });

  it("uses Ollama JSON Schema only on local routes without tools", () => {
    const model = makeCompletionsModel({
      ...proxy,
      provider: "ollama",
      id: "gemma4:e4b",
      baseUrl: "http://127.0.0.1:11434/v1",
      compat: { supportsJsonSchemaResponseFormat: true },
    });
    expect(
      buildOpenAICompletionsParams(model, emptyContext(), { responseFormat: schema })
        .response_format,
    ).toEqual({ type: "json_schema", json_schema: { name: "openclaw_response", schema } });
    const withTools = buildOpenAICompletionsParams(model, toolContext(), {
      responseFormat: schema,
    });
    expect(withTools.tools).toHaveLength(1);
    expect(withTools).not.toHaveProperty("response_format");
    expect(
      buildOpenAICompletionsParams({ ...model, baseUrl: "https://ollama.com/v1" }, emptyContext(), {
        responseFormat: schema,
      }),
    ).not.toHaveProperty("response_format");
  });
});

type ToolsModel = Omit<Model<"openai-completions">, "compat"> & Pick<OpenAIModeModel, "compat">;

const toolsNative = makeCompletionsModel({ id: "gpt-5" });
function historyContext(): Context {
  return {
    messages: [
      {
        role: "assistant",
        api: toolsNative.api,
        provider: toolsNative.provider,
        model: toolsNative.id,
        content: [{ type: "toolCall", id: "call_1", name: "lookup_weather", arguments: {} }],
        usage: createZeroUsage(),
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "lookup_weather",
        content: [{ type: "text", text: "sunny" }],
        isError: false,
        timestamp: 2,
      },
    ],
  };
}

const brokenTool: Tool = {
  name: "broken",
  description: "Unreadable schema",
  get parameters(): never {
    throw new Error("parameters exploded");
  },
};

function requestTools(
  model: Partial<ToolsModel>,
  context = emptyContext(),
  options?: OpenAICompletionsOptions,
) {
  const { compat, ...fields } = model;
  return buildOpenAICompletionsParams(
    { ...makeCompletionsModel(fields), compat },
    context,
    options,
  );
}

describe("OpenAI completions compatibility and tools", () => {
  it("keeps implicit tool choice limited to proxy endpoints", () => {
    const proxyParams = requestTools(
      { provider: "custom-cpa", baseUrl: "https://proxy.example.com/v1" },
      toolContext(),
    );
    expect(proxyParams.tool_choice).toBe("auto");
    const nativeParams = requestTools(toolsNative, toolContext());
    expect(nativeParams.tools).toHaveLength(1);
    expect(nativeParams).not.toHaveProperty("tool_choice");
  });

  it("applies provider and native-host compatibility defaults", () => {
    const cases = [
      [
        requestTools({
          id: "kimi-k2.5",
          provider: "moonshot",
          baseUrl: "",
          compat: { supportsUsageInStreaming: false },
        }),
        { "messages.0": { role: "system", content: "system" } },
        ["stream_options"],
      ],
      [
        requestTools(
          {
            id: "mistral-small-latest",
            provider: "custom-mistral-host",
            baseUrl: "https://api.mistral.ai/v1",
          },
          emptyContext(),
          { maxTokens: 2048, reasoningEffort: "high" },
        ),
        { max_tokens: 2048 },
        ["max_completion_tokens", "store", "reasoning_effort"],
      ],
      [
        requestTools({ id: "glm-5", provider: "zai", baseUrl: "" }, toolContext()),
        { "tools.0.function": expect.any(Object) },
        ["tools.0.function.strict"],
      ],
    ] as const;
    for (const [params, expected, absent] of cases) {
      for (const [path, value] of Object.entries(expected)) {
        expect(params).toHaveProperty(path, value);
      }
      for (const path of absent) {
        expect(params).not.toHaveProperty(path);
      }
    }
  });

  it("shapes message content and keys for restrictive backends", () => {
    const cases: [Partial<ToolsModel>, Context, unknown[]][] = [
      [
        { ...proxy, compat: { requiresStringContent: true } },
        {
          ...emptyContext(),
          messages: [
            { role: "user", content: [{ type: "text", text: "What is 2 + 2?" }], timestamp: 1 },
          ],
        },
        [
          { role: "system", content: "system" },
          { role: "user", content: "What is 2 + 2?" },
        ],
      ],
      [
        { ...proxy, compat: { strictMessageKeys: true } },
        { ...historyContext(), tools: [] },
        [
          { role: "assistant", content: null },
          { role: "tool", content: "sunny" },
        ],
      ],
    ];
    for (const [model, context, expected] of cases) {
      expect(requestTools(model, context).messages).toEqual(expected);
    }
  });

  it("keeps strict projected tools usable by required choice after quarantining bad schemas", () => {
    const params = requestTools(
      toolsNative,
      {
        ...emptyContext(),
        tools: [
          tool({
            type: "object",
            get properties(): never {
              throw new Error("properties exploded");
            },
          }),
          tool({}),
        ],
      },
      { toolChoice: "required" },
    );
    expect(params.tools?.map((entry) => entry.function)).toEqual([
      {
        name: "lookup_weather",
        description: "Get forecast",
        strict: true,
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      },
    ]);
    expect(params.tool_choice).toBe("required");
  });

  it("normalizes projected schemas according to strictness and compatibility", () => {
    const cases = [
      [
        requestTools(
          toolsNative,
          toolContext({
            type: "object",
            additionalProperties: false,
            properties: { path: { type: "string" } },
            required: [],
          }),
        ),
        { strict: false },
      ],
      [
        requestTools(
          { ...proxy, compat: { unsupportedToolSchemaKeywords: ["not"] } },
          toolContext({ type: "object", properties: { forbidden: { not: {} } } }),
        ),
        { "parameters.properties.forbidden": {} },
      ],
      [
        requestTools(
          { ...proxy, compat: { omitEmptyArrayItems: true } },
          toolContext({
            type: "object",
            properties: {
              hints: { type: "array" },
              typedHints: { type: "array", items: { type: "string" } },
            },
          }),
        ),
        {
          "parameters.properties.hints": { type: "array" },
          "parameters.properties.typedHints": { type: "array", items: { type: "string" } },
        },
      ],
    ] as const;
    for (const [params, expected] of cases) {
      for (const [path, value] of Object.entries(expected)) {
        expect(params.tools?.[0]?.function).toHaveProperty(path, value);
      }
    }
  });

  it("fails required choice when every schema is quarantined", () => {
    expect(() =>
      requestTools(
        toolsNative,
        { ...emptyContext(), tools: [brokenTool] },
        { toolChoice: "required" },
      ),
    ).toThrow("no tools survived schema conversion");
  });

  it("preserves history markers only for native requests with supported tools", () => {
    const unsupported = { ...proxy, compat: { ...proxy.compat, supportsTools: false } };
    const cases = [
      [requestTools(unsupported, { ...historyContext(), tools: [tool()] }), false],
      [requestTools(toolsNative, { ...historyContext(), tools: [brokenTool] }), true],
      [requestTools(proxy, historyContext()), false],
    ] as const;
    for (const [params, marker] of cases) {
      if (marker) {
        expect(params.tools).toEqual([]);
      } else {
        expect(params).not.toHaveProperty("tools");
        expect(params).not.toHaveProperty("tool_choice");
      }
    }
  });
});

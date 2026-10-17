import { describe, expect, it } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import type { OpenAICompletionsOptions } from "../provider-options.js";
import { FAILED_ASSISTANT_REPLAY_TEXT } from "../replay-turn-classification.js";
import type { Context, Model, Tool } from "../types.js";
import { resolveOpenAICompletionsCompat } from "./openai-completions-compat.js";
import {
  buildOpenAICompletionsParams,
  buildOpenAICompletionsRequest,
} from "./openai-completions-params.js";
import { createAssistantOutput, makeCompletionsModel } from "./openai-completions.test-support.js";
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
function objectSchema<T extends Record<string, unknown>>(
  properties: T,
  rest?: Record<string, unknown>,
) {
  return { type: "object", properties, ...rest };
}

function emptyContext(systemPrompt = "system"): Context {
  return { systemPrompt, messages: [], tools: [] };
}
function tool(parameters: Record<string, unknown> = objectSchema({})): Tool {
  return { name: "lookup_weather", description: "Get forecast", parameters };
}
function toolContext(parameters?: Record<string, unknown>): Context {
  return { ...emptyContext(), tools: [tool(parameters)] };
}
function request(
  model: Partial<ToolsModel>,
  options?: OpenAICompletionsOptions,
  context = emptyContext(),
) {
  const { compat, ...fields } = model;
  return buildOpenAICompletionsParams(
    { ...makeCompletionsModel(fields), compat },
    context,
    options,
  );
}

function requestMode(
  mode: "direct" | "managed",
  model: CompletionsModel,
  options: OpenAICompletionsOptions | undefined,
  context = emptyContext(),
) {
  return buildOpenAICompletionsRequest(
    model,
    context,
    options,
    mode === "direct"
      ? { mode, compat: resolveOpenAICompletionsCompat(model), cacheRetention: "none" }
      : { mode },
  );
}
function expectField(params: Record<string, unknown>, field: string, expected: unknown) {
  if (expected === undefined) {
    expect(params).not.toHaveProperty(field);
  } else {
    expect(params[field]).toEqual(expected);
  }
}

function expectBudget(
  params: ReturnType<typeof buildOpenAICompletionsParams>,
  expected: number | undefined,
  field = "max_completion_tokens",
) {
  expectField(params, field, expected);
  expect(params).not.toHaveProperty(
    field === "max_tokens" ? "max_completion_tokens" : "max_tokens",
  );
}

describe("OpenAI completions output budgets", () => {
  it.each([
    ["ｺ", 7_499],
    ["\u3400", 6_249],
    ["\u{20000}", 4_999],
  ] as const)("reserves weighted input space for repeated %s", (text, expected) => {
    const params = request(proxy, undefined, emptyContext(text.repeat(1_000)));
    expect(params.max_completion_tokens).toBe(expected);
  });

  it.each([
    { label: "non-reasoning", reasoning: false, effort: "off" },
    { label: "thinking off", reasoning: true, effort: "off" },
    { label: "thinking enabled", reasoning: true, effort: "medium" },
  ] as const)("rejects unusable context clamps for $label", ({ reasoning, effort }) => {
    const context = emptyContext("x".repeat(3200));
    for (const maxTokensField of ["max_tokens", "max_completion_tokens"] as const) {
      const model = {
        ...proxy,
        reasoning,
        compat: { thinkingFormat: "qwen" as const, maxTokensField },
      };
      const options = { reasoning: effort };
      for (const remaining of [-1, 0, 1, 15]) {
        expect(() =>
          request({ ...model, contextTokens: 1001 + remaining }, options, context),
        ).toThrowError(expect.objectContaining({ code: "context_length_exceeded" }));
      }
      expect(request({ ...model, contextTokens: 1017 }, options, context)[maxTokensField]).toBe(16);
      for (const maxTokens of [1, 15]) {
        expect(
          request(
            { ...model, contextTokens: 1001 + maxTokens },
            { ...options, maxTokens },
            context,
          )[maxTokensField],
        ).toBe(maxTokens);
        expect(() =>
          request({ ...model, contextTokens: 1001 }, { ...options, maxTokens }, context),
        ).toThrowError(expect.objectContaining({ code: "context_length_exceeded" }));
      }
    }
  });

  it("resolves runtime, model, and context caps without changing the output field", () => {
    const uncapped = makeCompletionsModel({
      id: "mimo-v2.5-pro",
      provider: "xiaomi",
      baseUrl: "https://api.xiaomimimo.com/v1",
    });
    Reflect.deleteProperty(uncapped, "maxTokens");
    expectBudget(
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
      64_000,
    );
    expectBudget(
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
      32_000,
    );
    expectBudget(
      request({ provider: "chutes", baseUrl: "", maxTokens: 65_536 }),
      65_536,
      "max_tokens",
    );
    expectBudget(
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
      4_999,
    );
    expectBudget(
      request(proxy, undefined, {
        messages: Array.from({ length: 4_000 }, () => ({
          role: "user",
          content: "x",
          timestamp: 1,
        })),
        tools: [],
      }),
      8_749,
    );
    expectBudget(buildOpenAICompletionsParams(uncapped, emptyContext(), undefined), undefined);
  });

  it("estimates the final replay marker instead of the aborted assistant text", () => {
    const params = request(proxy, undefined, {
      messages: [
        { role: "user", content: "ok", timestamp: 1 },
        {
          ...createAssistantOutput(proxy),
          content: [{ type: "text", text: "x".repeat(20_000) }],
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
  it.each(["direct", "managed"] as const)(
    "honors declared off efforts for inferred custom Z.AI (%s)",
    (mode) => {
      const cases: [NonNullable<CompletionsModel["compat"]>, string][] = [
        [{ supportedReasoningEfforts: ["none", "low"] }, "none"],
        [{ supportedReasoningEfforts: ["off", "low"] }, "off"],
        [{ supportedReasoningEfforts: [" none ", "low"] }, "none"],
        [{ reasoningEffortMap: { off: "none" } }, "none"],
        [{ reasoningEffortMap: { OFF: "low" } }, "low"],
      ];
      for (const [compat, expected] of cases) {
        const model = makeCompletionsModel({
          provider: "custom",
          id: "declared-off",
          baseUrl: "https://api.z.ai/api/paas/v4",
          compat: { ...compat, supportsReasoningEffort: true },
        });
        const params = requestMode(mode, model, { reasoningEffort: "off" });
        if (mode === "direct") {
          expect(params.thinking).toEqual(
            expected === "low" ? { type: "enabled", clear_thinking: false } : { type: "disabled" },
          );
          expect(params).not.toHaveProperty("reasoning_effort");
        } else {
          expect(params.reasoning_effort).toBe(expected);
          expect(params).not.toHaveProperty("thinking");
        }
      }
    },
  );

  it.each(["direct", "managed"] as const)(
    "omits inferred Z.AI off controls but preserves other custom contracts (%s)",
    (mode) => {
      for (const [baseUrl, thinkingFormat] of [
        ["https://api.z.ai/api/paas/v4", "zai"],
        ["https://api.deepseek.com", "deepseek"],
        ["https://api.together.ai/v1", "together"],
      ] as const) {
        for (const explicit of [false, true]) {
          const model = makeCompletionsModel({
            provider: "custom",
            id: "always-thinking",
            baseUrl,
            ...(explicit ? { compat: { thinkingFormat, supportsReasoningEffort: true } } : {}),
          });
          const params = requestMode(mode, model, { reasoningEffort: "off" });
          const hasOffContract = explicit || thinkingFormat !== "zai";
          if (hasOffContract && (mode === "direct" || thinkingFormat === "together")) {
            expect(params).toMatchObject(
              thinkingFormat === "together"
                ? { reasoning: { enabled: false } }
                : { thinking: { type: "disabled" } },
            );
          } else {
            expect(params).not.toHaveProperty("thinking");
            expect(params).not.toHaveProperty("reasoning");
          }
          if (
            mode === "managed" &&
            (thinkingFormat === "deepseek" || (explicit && thinkingFormat === "zai"))
          ) {
            expect(params.reasoning_effort).toBe("none");
          } else {
            expect(params).not.toHaveProperty("reasoning_effort");
          }
        }
      }
    },
  );

  it("preserves explicit Z.AI binary off when scalar effort is unavailable", () => {
    const model = makeCompletionsModel({
      provider: "custom",
      baseUrl: "https://api.z.ai/api/paas/v4",
      compat: { thinkingFormat: "zai" },
      thinkingLevelMap: { off: null },
    });
    const params = requestMode("direct", model, { reasoningEffort: "off" });
    expect(params.thinking).toEqual({ type: "disabled" });
    expect(params).not.toHaveProperty("reasoning_effort");
  });

  it.each(["direct", "managed"] as const)(
    "sends custom reasoning controls with conservative off defaults (%s)",
    (mode) => {
      const cases: [
        Partial<CompletionsModel>,
        OpenAICompletionsOptions["reasoningEffort"],
        string | undefined,
      ][] = [
        [{}, "low", "low"],
        [{}, "high", "high"],
        [{}, "off", undefined],
        [{ compat: { supportsReasoningEffort: true } }, "off", undefined],
        [{ id: "gpt-5.4" }, "off", undefined],
        [{ reasoning: false }, "high", undefined],
        [{ compat: { supportsReasoningEffort: false } }, "high", undefined],
        [{ compat: { reasoningEffortMap: { off: "none" } } }, "off", "none"],
        [{ compat: { supportedReasoningEfforts: ["none", "low", "high"] } }, "off", "none"],
        [{ thinkingLevelMap: { off: "low" } }, "off", "low"],
        [{ compat: { supportedReasoningEfforts: ["low", "high"] } }, "max", "high"],
        [{ compat: { supportedReasoningEfforts: ["low", "high", "max"] } }, "max", "max"],
      ];
      for (const baseUrl of ["http://localhost:8000/v1", "https://proxy.example.com/v1"]) {
        for (const [overrides, reasoningEffort, expected] of cases) {
          const model = makeCompletionsModel({ provider: "custom", baseUrl, ...overrides });
          const params = requestMode(mode, model, { reasoningEffort });
          expect(params.reasoning_effort, `${baseUrl} ${reasoningEffort}`).toBe(expected);
        }
      }
    },
  );

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
      expectField(params, "reasoning_effort", expected);
    }
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
    expectField(params, "reasoning_effort", expected);
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
        { sessionId: "session-123", cacheRetention: "long" },
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
          },
        },
        { cacheRetention: "long" },
        "session-123",
        undefined,
      ],
    ];
    for (const [model, options, key, retention] of cases) {
      const params = request(model, { sessionId: "session-123", ...options });
      expectField(params, "prompt_cache_key", key);
      expectField(params, "prompt_cache_retention", retention);
      expect(params).not.toHaveProperty("prompt_cache_options");
    }
  });
});

const nonReasoningNative = makeCompletionsModel({ id: "gpt-5.4", reasoning: false });
const schema = objectSchema(
  { reply: { type: "string" } },
  { required: ["reply"], additionalProperties: false },
);

describe("OpenAI completions sampling and response format", () => {
  it.each([
    [
      { temperature: 0.4, topP: 0.9 },
      { temperature: 0.4, top_p: 0.9 },
    ],
    [
      { frequencyPenalty: -0.5, presencePenalty: 1.25, seed: 12345 },
      { frequency_penalty: -0.5, presence_penalty: 1.25, seed: 12345 },
    ],
  ] as const)("forwards sampling controls %j", (options, expected) => {
    expect(request(nonReasoningNative, options)).toMatchObject(expected);
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
        ...createAssistantOutput(toolsNative),
        content: [{ type: "toolCall", id: "call_1", name: "lookup_weather", arguments: {} }],
        stopReason: "toolUse",
        timestamp: 1,
      },
      makeTextToolResult("call_1", "lookup_weather", "sunny", false, 2),
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

describe("OpenAI completions compatibility and tools", () => {
  it.each(["direct", "managed"] as const)(
    "types Moonshot union branches in outgoing tools without changing other providers (%s)",
    (mode) => {
      const parameters = objectSchema({ v: { anyOf: [{ enum: ["x", "y"] }, { minimum: 1 }] } });
      for (const [provider, baseUrl, moonshot] of [
        ["moonshot", "https://api.moonshot.ai/v1", true],
        ["custom", "https://api.moonshot.cn/v1", true],
        ["moonshotai", "", true],
        ["openai", "https://api.openai.com/v1", false],
        ["openrouter", "https://openrouter.ai/api/v1", false],
      ] as const) {
        const model = makeCompletionsModel({ id: "kimi-k2.6", provider, baseUrl });
        const payload = requestMode(mode, model, undefined, toolContext(parameters));
        expect(payload.tools?.[0]?.function.parameters, provider).toHaveProperty("properties.v", {
          anyOf: moonshot
            ? [
                { type: "string", enum: ["x", "y"] },
                { type: "number", minimum: 1 },
              ]
            : parameters.properties.v.anyOf,
        });
      }
      expect(parameters.properties.v.anyOf).toEqual([{ enum: ["x", "y"] }, { minimum: 1 }]);
    },
  );

  it("infers only unambiguous branch types and leaves literal data and explicit types intact", () => {
    const inferred = (branch: Record<string, unknown>, type: string, extra = {}) =>
      [branch, { ...structuredClone(branch), type, ...extra }] as const;
    const unchanged = (branch: Record<string, unknown>) =>
      [branch, structuredClone(branch)] as const;
    const cases = [
      inferred({ const: null }, "null"),
      inferred({ const: false }, "boolean"),
      inferred({ enum: [1, 2.5] }, "number"),
      inferred({ const: [] }, "array", { items: {} }),
      inferred({ const: {} }, "object"),
      inferred({ maximum: 9, multipleOf: 0.5 }, "number"),
      inferred({ minLength: 1, pattern: "x" }, "string"),
      inferred({ properties: { anyOf: { enum: ["x"] } } }, "object"),
      inferred({ required: ["a"] }, "object"),
      inferred({ items: { anyOf: [{ const: "x" }] } }, "array", {
        items: { anyOf: [{ const: "x", type: "string" }] },
      }),
      unchanged({ type: "integer", minimum: 1 }),
      unchanged({ description: "Unknown type" }),
      unchanged({ enum: ["x", 1] }),
      unchanged({ properties: {}, items: {} }),
    ];
    const literal = { anyOf: [{ enum: ["literal"] }] };
    for (const union of ["anyOf", "oneOf"] as const) {
      const payload = request(
        { provider: "moonshot", baseUrl: "https://api.moonshot.ai/v1", id: "kimi-k2.6" },
        undefined,
        toolContext(
          objectSchema({ v: { [union]: cases.map(([branch]) => branch), default: literal } }),
        ),
      );
      expect(payload.tools?.[0]?.function.parameters).toEqual(
        objectSchema({ v: { [union]: cases.map(([, expected]) => expected), default: literal } }),
      );
    }
  });

  it("keeps implicit tool choice limited to proxy endpoints", () => {
    const proxyParams = request(
      { provider: "custom-cpa", baseUrl: "https://proxy.example.com/v1" },
      undefined,
      toolContext(),
    );
    expect(proxyParams.tool_choice).toBe("auto");
    const nativeParams = request(toolsNative, undefined, toolContext());
    expect(nativeParams.tools).toHaveLength(1);
    expect(nativeParams).not.toHaveProperty("tool_choice");
  });

  it("applies provider and native-host compatibility defaults", () => {
    const cases = [
      [
        request({
          id: "kimi-k2.5",
          provider: "moonshot",
          baseUrl: "",
          compat: { supportsUsageInStreaming: false },
        }),
        { "messages.0": { role: "system", content: "system" } },
        ["stream_options"],
      ],
      [
        request(
          {
            id: "mistral-small-latest",
            provider: "custom-mistral-host",
            baseUrl: "https://api.mistral.ai/v1",
          },
          { maxTokens: 2048, reasoningEffort: "high" },
          emptyContext(),
        ),
        { max_tokens: 2048 },
        ["max_completion_tokens", "store", "reasoning_effort"],
      ],
      [
        request({ id: "glm-5", provider: "zai", baseUrl: "" }, undefined, toolContext()),
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
          {
            role: "assistant",
            content:
              "[tool call id=call_1 name=lookup_weather] {}\n[tool result id=call_1 name=lookup_weather] sunny",
          },
        ],
      ],
    ];
    for (const [model, context, expected] of cases) {
      expect(request(model, undefined, context).messages).toEqual(expected);
    }
  });

  it("keeps strict projected tools usable by required choice after quarantining bad schemas", () => {
    const params = request(
      toolsNative,
      { toolChoice: "required" },
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
    );
    expect(params.tools?.map((entry) => entry.function)).toEqual([
      {
        name: "lookup_weather",
        description: "Get forecast",
        strict: true,
        parameters: objectSchema({}, { required: [], additionalProperties: false }),
      },
    ]);
    expect(params.tool_choice).toBe("required");
  });

  it("normalizes projected schemas according to strictness and compatibility", () => {
    const cases = [
      [
        toolsNative,
        objectSchema({ path: { type: "string" } }, { additionalProperties: false, required: [] }),
        { strict: false },
      ],
      [
        { ...proxy, compat: { unsupportedToolSchemaKeywords: ["not"] } },
        objectSchema({ forbidden: { not: {} } }),
        { "parameters.properties.forbidden": {} },
      ],
      [
        { ...proxy, compat: { omitEmptyArrayItems: true } },
        objectSchema({
          hints: { type: "array" },
          typedHints: { type: "array", items: { type: "string" } },
        }),
        {
          "parameters.properties.hints": { type: "array" },
          "parameters.properties.typedHints": { type: "array", items: { type: "string" } },
        },
      ],
    ] satisfies [Partial<ToolsModel>, Record<string, unknown>, Record<string, unknown>][];
    for (const [model, parameters, expected] of cases) {
      const projected = request(model, undefined, toolContext(parameters)).tools?.[0]?.function;
      for (const [path, value] of Object.entries(expected)) {
        expect(projected).toHaveProperty(path, value);
      }
    }
  });

  it("fails required choice when every schema is quarantined", () => {
    expect(() =>
      request(toolsNative, { toolChoice: "required" }, { ...emptyContext(), tools: [brokenTool] }),
    ).toThrow("no tools survived schema conversion");
  });

  it("preserves history markers only for native requests with supported tools", () => {
    const unsupported = { ...proxy, compat: { ...proxy.compat, supportsTools: false } };
    const cases = [
      [request(unsupported, undefined, { ...historyContext(), tools: [tool()] }), false],
      [request(toolsNative, undefined, { ...historyContext(), tools: [brokenTool] }), true],
      [request(proxy, undefined, historyContext()), false],
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

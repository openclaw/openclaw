import { describe, expect, it } from "vitest";
import type { OpenAICompletionsOptions } from "../provider-options.js";
import type { Context, Model, Tool } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import { makeCompletionsModel } from "./openai-completions.test-support.js";
import type { OpenAIModeModel } from "./openai-transport-shared.js";

type CompletionsModel = Omit<Model<"openai-completions">, "compat"> &
  Pick<OpenAIModeModel, "compat">;

const native = makeCompletionsModel({ id: "gpt-5" });
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

function historyContext(): Context {
  return {
    messages: [
      {
        role: "assistant",
        api: native.api,
        provider: native.provider,
        model: native.id,
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

function request(
  model: Partial<CompletionsModel>,
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
    const params = request(
      { provider: "custom-cpa", baseUrl: "https://proxy.example.com/v1" },
      toolContext(),
      { reasoningEffort: "high" },
    );
    expect(params.messages[0]).toEqual({ role: "system", content: "system" });
    for (const key of ["reasoning_effort", "stream_options", "store"]) {
      expect(params).not.toHaveProperty(key);
    }
    expect(params.tools?.[0]?.function).not.toHaveProperty("strict");
    expect(params.tool_choice).toBe("auto");
    const nativeParams = request(native, toolContext());
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
          emptyContext(),
          { maxTokens: 2048, reasoningEffort: "high" },
        ),
        { max_tokens: 2048 },
        ["max_completion_tokens", "store", "reasoning_effort"],
      ],
      [
        request({ id: "glm-5", provider: "zai", baseUrl: "" }, toolContext()),
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
    const cases: [Partial<CompletionsModel>, Context, unknown[]][] = [
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
      expect(request(model, context).messages).toEqual(expected);
    }
  });

  it("keeps strict projected tools usable by required choice after quarantining bad schemas", () => {
    const params = request(
      native,
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
        request(
          native,
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
        request(
          { ...proxy, compat: { unsupportedToolSchemaKeywords: ["not"] } },
          toolContext({ type: "object", properties: { forbidden: { not: {} } } }),
        ),
        { "parameters.properties.forbidden": {} },
      ],
      [
        request(
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
      request(native, { ...emptyContext(), tools: [brokenTool] }, { toolChoice: "required" }),
    ).toThrow("no tools survived schema conversion");
  });

  it("preserves history markers only for native requests with supported tools", () => {
    const unsupported = { ...proxy, compat: { ...proxy.compat, supportsTools: false } };
    const cases = [
      [request(unsupported, { ...historyContext(), tools: [tool()] }), false],
      [request(native, { ...historyContext(), tools: [brokenTool] }), true],
      [request(proxy, historyContext()), false],
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

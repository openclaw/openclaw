import { describe, expect, it } from "vitest";
import type { Context, Tool } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import { makeCompletionsModel } from "./openai-completions.test-support.js";

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

describe("OpenAI completions compatibility and tools", () => {
  it("uses proxy defaults and automatic tool choice without native-only fields", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({ provider: "custom-cpa", baseUrl: "https://proxy.example.com/v1" }),
      toolContext(),
      { reasoningEffort: "high" },
    );
    expect(params.messages[0]).toEqual({ role: "system", content: "system" });
    expect(params).not.toHaveProperty("reasoning_effort");
    expect(params).not.toHaveProperty("stream_options");
    expect(params).not.toHaveProperty("store");
    expect(params.tools?.[0]?.function).not.toHaveProperty("strict");
    expect(params.tool_choice).toBe("auto");
  });

  it("honors streaming usage opt-out on the Moonshot default route", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "kimi-k2.5",
        provider: "moonshot",
        baseUrl: "",
        compat: { supportsUsageInStreaming: false },
      }),
      emptyContext(),
      undefined,
    );
    expect(params.messages[0]).toEqual({ role: "system", content: "system" });
    expect(params).not.toHaveProperty("stream_options");
  });

  it("uses Mistral defaults for custom providers on native Mistral hosts", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "mistral-small-latest",
        provider: "custom-mistral-host",
        baseUrl: "https://api.mistral.ai/v1",
      }),
      emptyContext(),
      { maxTokens: 2048, reasoningEffort: "high" },
    );
    expect(params.max_tokens).toBe(2048);
    expect(params).not.toHaveProperty("max_completion_tokens");
    expect(params).not.toHaveProperty("store");
    expect(params).not.toHaveProperty("reasoning_effort");
  });

  it("flattens text blocks for string-only backends", () => {
    const model = { ...proxy, compat: { requiresStringContent: true } };
    const params = buildOpenAICompletionsParams(
      model,
      {
        ...emptyContext(),
        messages: [
          { role: "user", content: [{ type: "text", text: "What is 2 + 2?" }], timestamp: 1 },
        ],
      },
      undefined,
    );
    expect(params.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "What is 2 + 2?" },
    ]);
  });

  it("strips tool-call metadata for strict-key backends", () => {
    const model = { ...proxy, compat: { strictMessageKeys: true } };
    const params = buildOpenAICompletionsParams(
      model,
      { ...historyContext(), tools: [] },
      undefined,
    );
    expect(params.messages).toEqual([
      { role: "assistant", content: null },
      { role: "tool", content: "sunny" },
    ]);
  });

  it("omits strict tool shaping on the Z.ai default route", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({ id: "glm-5", provider: "zai", baseUrl: "" }),
      toolContext(),
      undefined,
    );
    expect(params.tools?.[0]?.function).not.toHaveProperty("strict");
  });

  it("keeps strict projected tools usable by required choice after quarantining bad schemas", () => {
    const params = buildOpenAICompletionsParams(
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

  it("downgrades a non-strict-compatible native schema to strict:false", () => {
    const params = buildOpenAICompletionsParams(
      native,
      toolContext({
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string" } },
        required: [],
      }),
      undefined,
    );
    expect(params.tools?.[0]?.function.strict).toBe(false);
  });

  it("removes configured unsupported schema keywords", () => {
    const model = { ...proxy, compat: { unsupportedToolSchemaKeywords: ["not"] } };
    const params = buildOpenAICompletionsParams(
      model,
      toolContext({ type: "object", properties: { forbidden: { not: {} } } }),
      undefined,
    );
    expect(params.tools?.[0]?.function.parameters).toHaveProperty("properties.forbidden", {});
  });

  it("omits empty array items without losing typed items", () => {
    const model = { ...proxy, compat: { omitEmptyArrayItems: true } };
    const params = buildOpenAICompletionsParams(
      model,
      toolContext({
        type: "object",
        properties: {
          hints: { type: "array" },
          typedHints: { type: "array", items: { type: "string" } },
        },
      }),
      undefined,
    );
    expect(params.tools?.[0]?.function.parameters).toHaveProperty("properties.hints", {
      type: "array",
    });
    expect(params.tools?.[0]?.function.parameters).toHaveProperty("properties.typedHints", {
      type: "array",
      items: { type: "string" },
    });
  });

  it("omits both active tools and the history marker when tools are unsupported", () => {
    const model = { ...proxy, compat: { ...proxy.compat, supportsTools: false } };
    const params = buildOpenAICompletionsParams(
      model,
      { ...historyContext(), tools: [tool()] },
      undefined,
    );
    expect(params).not.toHaveProperty("tools");
    expect(params).not.toHaveProperty("tool_choice");
  });

  it("fails required choice when every schema is quarantined", () => {
    expect(() =>
      buildOpenAICompletionsParams(
        native,
        { ...emptyContext(), tools: [brokenTool] },
        { toolChoice: "required" },
      ),
    ).toThrow("no tools survived schema conversion");
  });

  it("preserves the native history marker after quarantining every schema", () => {
    const params = buildOpenAICompletionsParams(
      native,
      { ...historyContext(), tools: [brokenTool] },
      undefined,
    );
    expect(params.tools).toEqual([]);
  });

  it("omits empty tools and tool choice for proxy requests with only tool history", () => {
    const params = buildOpenAICompletionsParams(proxy, historyContext(), undefined);
    expect(params).not.toHaveProperty("tools");
    expect(params).not.toHaveProperty("tool_choice");
  });
});

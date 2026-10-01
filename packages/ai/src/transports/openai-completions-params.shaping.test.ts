import { describe, expect, it } from "vitest";
import type { Context } from "../types.js";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import { makeCompletionsModel } from "./openai-completions.test-support.js";

const native = makeCompletionsModel({ id: "gpt-5.4", reasoning: false });
const proxy = makeCompletionsModel({
  provider: "vllm",
  baseUrl: "http://localhost:8000/v1",
  reasoning: false,
  contextWindow: 10_000,
  maxTokens: 10_000,
});
const schema = {
  type: "object",
  properties: { reply: { type: "string" } },
  required: ["reply"],
  additionalProperties: false,
};

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

describe("OpenAI completions sampling and response format", () => {
  it("forwards temperature and top_p", () => {
    const params = buildOpenAICompletionsParams(native, emptyContext(), {
      temperature: 0.4,
      topP: 0.9,
    });
    expect(params.temperature).toBe(0.4);
    expect(params.top_p).toBe(0.9);
  });

  it("forwards penalties and seed", () => {
    const params = buildOpenAICompletionsParams(native, emptyContext(), {
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
      buildOpenAICompletionsParams(native, emptyContext(), {
        stop: ["User:", "Assistant:"],
      }).stop,
    ).toEqual(["User:", "Assistant:"]);
  });

  it("preserves native response formats and wraps bare JSON schemas", () => {
    for (const responseFormat of [
      { type: "json_object" },
      { type: "text" },
      { type: "json_schema", json_schema: {} },
    ]) {
      expect(
        buildOpenAICompletionsParams(native, emptyContext(), { responseFormat }).response_format,
      ).toEqual(responseFormat);
    }
    expect(
      buildOpenAICompletionsParams(native, emptyContext(), { responseFormat: schema })
        .response_format,
    ).toEqual({ type: "json_schema", json_schema: { name: "openclaw_response", schema } });
    expect(buildOpenAICompletionsParams(native, emptyContext(), {})).not.toHaveProperty(
      "response_format",
    );
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

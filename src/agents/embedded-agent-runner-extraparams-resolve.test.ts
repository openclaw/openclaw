// Covers resolving configured extra params before provider stream wrapping.
import { describe, expect, it } from "vitest";
import { resolveExtraParams } from "./embedded-agent-runner/extra-params.js";

describe("resolveExtraParams", () => {
  it.each([
    [
      "applies default runtime params for OpenAI GPT-5 models",
      "openai",
      {
        parallel_tool_calls: true,
        text_verbosity: "low",
      },
    ],
    ["does not apply OpenAI GPT-5 defaults to OpenRouter models", "openrouter", undefined],
  ] as const)("%s", (_name, provider, expected) => {
    const result = resolveExtraParams({ cfg: undefined, provider, modelId: "gpt-5.4" });
    if (expected === undefined) {
      expect(result).toBeUndefined();
    } else {
      expect(result).toEqual(expected);
    }
  });

  it.each([
    [
      "returns params for exact provider/model key",
      "gpt-4",
      { temperature: 0.7, maxTokens: 2048 },
      { temperature: 0.7, maxTokens: 2048 },
    ],
    ["ignores unrelated model entries", "gpt-4.1-mini", { temperature: 0.7 }, undefined],
  ] as const)("%s", (_name, modelId, configuredParams, expected) => {
    const result = resolveExtraParams({
      cfg: { agents: { defaults: { models: { "openai/gpt-4": { params: configuredParams } } } } },
      provider: "openai",
      modelId,
    });
    if (expected === undefined) {
      expect(result).toBeUndefined();
    } else {
      expect(result).toEqual(expected);
    }
  });

  it("merges per-agent params over global model defaults", () => {
    // Agent-specific params are narrower than model defaults and must win on
    // overlapping keys.
    const result = resolveExtraParams({
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-6": {
                params: {
                  temperature: 0.5,
                  cacheRetention: "long",
                },
              },
            },
          },
          entries: { "risk-reviewer": { params: { cacheRetention: "none" } } },
        },
      },
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentId: "risk-reviewer",
    });

    expect(result).toEqual({
      temperature: 0.5,
      cacheRetention: "none",
    });
  });

  it.each([
    {
      name: "parallelToolCalls",
      modelId: "gpt-4.1",
      modelParams: { parallel_tool_calls: true },
      agentParams: { parallelToolCalls: false },
      expected: { parallel_tool_calls: false },
    },
    {
      name: "textVerbosity",
      modelId: "gpt-5.4",
      modelParams: { text_verbosity: "high" },
      agentParams: { textVerbosity: "low" },
      expected: { parallel_tool_calls: true, text_verbosity: "low" },
    },
    {
      name: "responseFormat",
      modelId: "gpt-5.4",
      modelParams: { response_format: { type: "text" } },
      agentParams: { responseFormat: { type: "json_object" } },
      expected: {
        parallel_tool_calls: true,
        response_format: { type: "json_object" },
        text_verbosity: "low",
      },
    },
  ])(
    "canonicalizes $name after applying agent override precedence",
    ({ modelId, modelParams, agentParams, expected }) => {
      expect(
        resolveExtraParams({
          cfg: {
            agents: {
              defaults: { models: { [`openai/${modelId}`]: { params: modelParams } } },
              entries: { main: { params: agentParams } },
            },
          },
          provider: "openai",
          modelId,
          agentId: "main",
        }),
      ).toEqual(expected);
    },
  );

  it("ignores per-agent params when agentId does not match", () => {
    const result = resolveExtraParams({
      cfg: {
        agents: {
          entries: { "risk-reviewer": { params: { cacheRetention: "none" } } },
        },
      },
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentId: "main",
    });

    expect(result).toBeUndefined();
  });
});

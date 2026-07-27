// Covers resolving configured extra params before provider stream wrapping.
import { describe, expect, it } from "vitest";
import { resolveExtraParams } from "./embedded-agent-runner/extra-params.js";

const AGENT_MODEL_PARAM_CASES = [
  {
    provider: "openai",
    modelId: "gpt-5.6-luna",
    params: { temperature: 0.1, topP: 0.2, serviceTier: "priority", transport: "websocket" },
  },
  {
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    params: { temperature: 0.2, topP: 0.3, maxTokens: 321, cacheRetention: "short" },
  },
  {
    provider: "google",
    modelId: "gemini-2.5-pro",
    params: { temperature: 0.3, topP: 0.4, cachedContent: "cachedContents/agent-model-proof" },
  },
  {
    provider: "google-vertex",
    modelId: "gemini-2.5-pro",
    params: { temperature: 0.4, topP: 0.5, maxTokens: 456 },
  },
];

describe("resolveExtraParams", () => {
  it("returns undefined with no model config", () => {
    const result = resolveExtraParams({
      cfg: undefined,
      provider: "zai",
      modelId: "glm-4.7",
    });

    expect(result).toBeUndefined();
  });

  it("applies default runtime params for OpenAI GPT-5 models", () => {
    const result = resolveExtraParams({
      cfg: undefined,
      provider: "openai",
      modelId: "gpt-5.4",
    });

    expect(result).toEqual({
      parallel_tool_calls: true,
      text_verbosity: "low",
    });
  });

  it("returns params for exact provider/model key", () => {
    const result = resolveExtraParams({
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-4": {
                params: {
                  temperature: 0.7,
                  maxTokens: 2048,
                },
              },
            },
          },
        },
      },
      provider: "openai",
      modelId: "gpt-4",
    });

    expect(result).toEqual({
      temperature: 0.7,
      maxTokens: 2048,
    });
  });

  it("ignores unrelated model entries", () => {
    const result = resolveExtraParams({
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-4": {
                params: {
                  temperature: 0.7,
                },
              },
            },
          },
        },
      },
      provider: "openai",
      modelId: "gpt-4.1-mini",
    });

    expect(result).toBeUndefined();
  });

  it("returns per-agent params when agentId matches", () => {
    const result = resolveExtraParams({
      cfg: {
        agents: {
          list: [
            {
              id: "risk-reviewer",
              params: { cacheRetention: "none" },
            },
          ],
        },
      },
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentId: "risk-reviewer",
    });

    expect(result).toEqual({ cacheRetention: "none" });
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
          list: [
            {
              id: "risk-reviewer",
              params: { cacheRetention: "none" },
            },
          ],
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

  it.each(AGENT_MODEL_PARAM_CASES)(
    "applies canonical agent-specific model params for $provider/$modelId",
    ({ provider, modelId, params }) => {
      const modelRef = `${provider}/${modelId}`;
      const result = resolveExtraParams({
        cfg: {
          agents: {
            entries: {
              audit: {
                models: { [modelRef]: { params } },
              },
            },
          },
        },
        provider,
        modelId,
        agentId: "audit",
      });

      expect(result).toEqual(expect.objectContaining(params));
    },
  );

  it.each(AGENT_MODEL_PARAM_CASES)(
    "applies the narrowest agent-specific model precedence for $provider/$modelId",
    ({ provider, modelId, params }) => {
      const modelRef = `${provider}/${modelId}`;
      const result = resolveExtraParams({
        cfg: {
          agents: {
            defaults: {
              params: { temperature: 0.9, topP: 0.9, cacheRetention: "long" },
              models: {
                [modelRef]: {
                  params: { temperature: 0.8, topP: 0.8, maxTokens: 2048 },
                },
              },
            },
            entries: {
              audit: {
                params: { temperature: 0.7, cacheRetention: "none" },
                models: { [modelRef]: { params } },
              },
            },
          },
        },
        provider,
        modelId,
        agentId: "audit",
      });

      expect(result).toEqual(
        expect.objectContaining({
          maxTokens: 2048,
          cacheRetention: "none",
          ...params,
        }),
      );
    },
  );

  it("ignores model params belonging to another agent", () => {
    const result = resolveExtraParams({
      cfg: {
        agents: {
          entries: {
            audit: {
              models: {
                "anthropic/claude-sonnet-4-6": { params: { temperature: 0.2 } },
              },
            },
            main: {},
          },
        },
      },
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      agentId: "main",
    });

    expect(result).toBeUndefined();
  });

  it("ignores the selected agent's params for another model", () => {
    const result = resolveExtraParams({
      cfg: {
        agents: {
          entries: {
            audit: {
              models: {
                "anthropic/claude-sonnet-4-6": { params: { temperature: 0.2 } },
              },
            },
          },
        },
      },
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentId: "audit",
    });

    expect(result).toBeUndefined();
  });

  it("preserves higher-precedence agent parallelToolCalls override across alias styles", () => {
    // Canonicalization must happen after precedence resolution, or a broad
    // snake_case value can overwrite the agent's camelCase override.
    const result = resolveExtraParams({
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-4.1": {
                params: {
                  parallel_tool_calls: true,
                },
              },
            },
          },
          list: [
            {
              id: "main",
              params: {
                parallelToolCalls: false,
              },
            },
          ],
        },
      },
      provider: "openai",
      modelId: "gpt-4.1",
      agentId: "main",
    });

    expect(result).toEqual({
      parallel_tool_calls: false,
    });
  });

  it("canonicalizes text verbosity alias styles with agent override precedence", () => {
    const result = resolveExtraParams({
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  text_verbosity: "high",
                },
              },
            },
          },
          list: [
            {
              id: "main",
              params: {
                textVerbosity: "low",
              },
            },
          ],
        },
      },
      provider: "openai",
      modelId: "gpt-5.4",
      agentId: "main",
    });

    expect(result).toEqual({
      parallel_tool_calls: true,
      text_verbosity: "low",
    });
  });

  it("canonicalizes response format alias styles with agent override precedence", () => {
    // Response-format aliases feed provider payloads directly, so merge order and
    // key normalization have to produce one canonical response_format value.
    const result = resolveExtraParams({
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  response_format: { type: "text" },
                },
              },
            },
          },
          list: [
            {
              id: "main",
              params: {
                responseFormat: { type: "json_object" },
              },
            },
          ],
        },
      },
      provider: "openai",
      modelId: "gpt-5.4",
      agentId: "main",
    });

    expect(result).toEqual({
      parallel_tool_calls: true,
      response_format: { type: "json_object" },
      text_verbosity: "low",
    });
  });

  it("ignores per-agent params when agentId does not match", () => {
    const result = resolveExtraParams({
      cfg: {
        agents: {
          list: [
            {
              id: "risk-reviewer",
              params: { cacheRetention: "none" },
            },
          ],
        },
      },
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentId: "main",
    });

    expect(result).toBeUndefined();
  });
});

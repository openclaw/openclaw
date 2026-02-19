import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { applyExtraParamsToAgent, resolveExtraParams } from "./pi-embedded-runner.js";
import { isCacheTtlEligibleProvider } from "./pi-embedded-runner/cache-ttl.js";

describe("resolveExtraParams", () => {
  it("returns undefined with no model config", () => {
    const result = resolveExtraParams({
      cfg: undefined,
      provider: "zai",
      modelId: "glm-4.7",
    });

    expect(result).toBeUndefined();
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
});

describe("applyExtraParamsToAgent", () => {
  function createOptionsCaptureAgent() {
    const calls: Array<SimpleStreamOptions | undefined> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push(options);
      return {} as ReturnType<StreamFn>;
    };
    return {
      calls,
      agent: { streamFn: baseStreamFn },
    };
  }

  function buildAnthropicModelConfig(modelKey: string, params: Record<string, unknown>) {
    return {
      agents: {
        defaults: {
          models: {
            [modelKey]: { params },
          },
        },
      },
    };
  }

  function runStoreMutationCase(params: {
    applyProvider: string;
    applyModelId: string;
    model:
      | Model<"openai-responses">
      | Model<"openai-codex-responses">
      | Model<"openai-completions">;
    options?: SimpleStreamOptions;
  }) {
    const payload = { store: false };
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };
    applyExtraParamsToAgent(agent, undefined, params.applyProvider, params.applyModelId);
    const context: Context = { messages: [] };
    void agent.streamFn?.(params.model, context, params.options ?? {});
    return payload;
  }

  it("adds OpenRouter attribution headers to stream options", () => {
    const { calls, agent } = createOptionsCaptureAgent();

    applyExtraParamsToAgent(agent, undefined, "openrouter", "openrouter/auto");

    const model = {
      api: "openai-completions",
      provider: "openrouter",
      id: "openrouter/auto",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, { headers: { "X-Custom": "1" } });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers).toEqual({
      "HTTP-Referer": "https://openclaw.ai",
      "X-Title": "OpenClaw",
      "X-Custom": "1",
    });
  });

  it("adds Anthropic 1M beta header when context1m is enabled for Opus/Sonnet", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = buildAnthropicModelConfig("anthropic/claude-opus-4-6", { context1m: true });

    applyExtraParamsToAgent(agent, cfg, "anthropic", "claude-opus-4-6");

    const model = {
      api: "anthropic-messages",
      provider: "anthropic",
      id: "claude-opus-4-6",
    } as Model<"anthropic-messages">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, { headers: { "X-Custom": "1" } });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers).toEqual({
      "X-Custom": "1",
      "anthropic-beta": "context-1m-2025-08-07",
    });
  });

  it("merges existing anthropic-beta headers with configured betas", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = buildAnthropicModelConfig("anthropic/claude-sonnet-4-5", {
      context1m: true,
      anthropicBeta: ["files-api-2025-04-14"],
    });

    applyExtraParamsToAgent(agent, cfg, "anthropic", "claude-sonnet-4-5");

    const model = {
      api: "anthropic-messages",
      provider: "anthropic",
      id: "claude-sonnet-4-5",
    } as Model<"anthropic-messages">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {
      headers: { "anthropic-beta": "prompt-caching-2024-07-31" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers).toEqual({
      "anthropic-beta": "prompt-caching-2024-07-31,files-api-2025-04-14,context-1m-2025-08-07",
    });
  });

  it("ignores context1m for non-Opus/Sonnet Anthropic models", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = buildAnthropicModelConfig("anthropic/claude-haiku-3-5", { context1m: true });

    applyExtraParamsToAgent(agent, cfg, "anthropic", "claude-haiku-3-5");

    const model = {
      api: "anthropic-messages",
      provider: "anthropic",
      id: "claude-haiku-3-5",
    } as Model<"anthropic-messages">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, { headers: { "X-Custom": "1" } });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers).toEqual({ "X-Custom": "1" });
  });

  it("forces store=true for direct OpenAI Responses payloads", () => {
    const payload = runStoreMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
    });
    expect(payload.store).toBe(true);
  });

  it("does not force store for OpenAI Responses routed through non-OpenAI base URLs", () => {
    const payload = runStoreMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://proxy.example.com/v1",
      } as Model<"openai-responses">,
    });
    expect(payload.store).toBe(false);
  });

  it("does not force store=true for Codex responses (Codex requires store=false)", () => {
    const payload = runStoreMutationCase({
      applyProvider: "openai-codex",
      applyModelId: "codex-mini-latest",
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "codex-mini-latest",
        baseUrl: "https://chatgpt.com/backend-api/codex/responses",
      } as Model<"openai-codex-responses">,
    });
    expect(payload.store).toBe(false);
  });

  it("does not force store=true for Codex responses (Codex requires store=false)", () => {
    const payload = { store: false };
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "openai-codex", "codex-mini-latest");

    const model = {
      api: "openai-codex-responses",
      provider: "openai-codex",
      id: "codex-mini-latest",
      baseUrl: "https://chatgpt.com/backend-api/codex/responses",
    } as Model<"openai-codex-responses">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {});

    expect(payload.store).toBe(false);
  });

  it("applies cacheRetention for google-vertex provider", () => {
    const calls: Array<SimpleStreamOptions | undefined> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push(options);
      return new AssistantMessageEventStream();
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      {
        agents: {
          defaults: {
            models: {
              "google-vertex/claude-opus-4-6": {
                params: { cacheRetention: "short" },
              },
            },
          },
        },
      },
      "google-vertex",
      "claude-opus-4-6",
    );

    const model = {
      api: "anthropic",
      provider: "google-vertex",
      id: "claude-opus-4-6",
    } as Model<"anthropic">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect((calls[0] as Record<string, unknown>).cacheRetention).toBe("short");
  });

  it("does not apply cacheRetention for non-anthropic/non-vertex providers", () => {
    const calls: Array<SimpleStreamOptions | undefined> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push(options);
      return new AssistantMessageEventStream();
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5": {
                params: { cacheRetention: "short" },
              },
            },
          },
        },
      },
      "openai",
      "gpt-5",
    );

    const model = {
      api: "openai-completions",
      provider: "openai",
      id: "gpt-5",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {});

    // streamFn should not have been wrapped with cacheRetention since
    // the underlying createStreamFnWithExtraParams strips non-applicable params.
    // The call goes through the OpenAI store wrapper which doesn't add cacheRetention.
    expect(calls).toHaveLength(1);
    expect((calls[0] as Record<string, unknown>).cacheRetention).toBeUndefined();
  });
});

describe("isCacheTtlEligibleProvider", () => {
  it("returns true for anthropic provider", () => {
    expect(isCacheTtlEligibleProvider("anthropic", "claude-opus-4-6")).toBe(true);
  });

  it("returns true for google-vertex provider", () => {
    expect(isCacheTtlEligibleProvider("google-vertex", "claude-opus-4-6")).toBe(true);
  });

  it("returns true for openrouter with anthropic model", () => {
    expect(isCacheTtlEligibleProvider("openrouter", "anthropic/claude-opus-4-6")).toBe(true);
  });

  it("returns false for openrouter with non-anthropic model", () => {
    expect(isCacheTtlEligibleProvider("openrouter", "google/gemini-3-pro")).toBe(false);
  });

  it("returns false for other providers", () => {
    expect(isCacheTtlEligibleProvider("openai", "gpt-5")).toBe(false);
  });

  it("is case-insensitive for provider", () => {
    expect(isCacheTtlEligibleProvider("Google-Vertex", "claude-opus-4-6")).toBe(true);
    expect(isCacheTtlEligibleProvider("ANTHROPIC", "claude-opus-4-6")).toBe(true);
  });
});

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { applyExtraParamsToAgent, resolveExtraParams } from "./pi-embedded-runner.js";

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

  function runAnthropicHeaderCase(params: {
    cfg: Record<string, unknown>;
    modelId: string;
    options?: SimpleStreamOptions;
  }) {
    const { calls, agent } = createOptionsCaptureAgent();
    applyExtraParamsToAgent(agent, params.cfg, "anthropic", params.modelId);

    const model = {
      api: "anthropic-messages",
      provider: "anthropic",
      id: params.modelId,
    } as Model<"anthropic-messages">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, params.options ?? {});

    expect(calls).toHaveLength(1);
    return calls[0]?.headers;
  }

  it("does not inject reasoning when thinkingLevel is off (default) for OpenRouter", () => {
    // Regression: "off" is a truthy string, so the old code injected
    // reasoning: { effort: "none" }, causing a 400 on models that require
    // reasoning (e.g. deepseek/deepseek-r1).
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = { model: "deepseek/deepseek-r1" };
      options?.onPayload?.(payload);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      undefined,
      "openrouter",
      "deepseek/deepseek-r1",
      undefined,
      "off",
    );

    const model = {
      api: "openai-completions",
      provider: "openrouter",
      id: "deepseek/deepseek-r1",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).not.toHaveProperty("reasoning");
    expect(payloads[0]).not.toHaveProperty("reasoning_effort");
  });

  it("injects reasoning.effort when thinkingLevel is non-off for OpenRouter", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {};
      options?.onPayload?.(payload);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "openrouter", "openrouter/auto", undefined, "low");

    const model = {
      api: "openai-completions",
      provider: "openrouter",
      id: "openrouter/auto",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.reasoning).toEqual({ effort: "low" });
  });

  it("removes legacy reasoning_effort and keeps reasoning unset when thinkingLevel is off", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = { reasoning_effort: "high" };
      options?.onPayload?.(payload);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "openrouter", "openrouter/auto", undefined, "off");

    const model = {
      api: "openai-completions",
      provider: "openrouter",
      id: "openrouter/auto",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).not.toHaveProperty("reasoning_effort");
    expect(payloads[0]).not.toHaveProperty("reasoning");
  });

  it("does not inject effort when payload already has reasoning.max_tokens", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = { reasoning: { max_tokens: 256 } };
      options?.onPayload?.(payload);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "openrouter", "openrouter/auto", undefined, "low");

    const model = {
      api: "openai-completions",
      provider: "openrouter",
      id: "openrouter/auto",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({ reasoning: { max_tokens: 256 } });
  });

  it("normalizes thinking=off to null for SiliconFlow Pro models", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = { thinking: "off" };
      options?.onPayload?.(payload);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      undefined,
      "siliconflow",
      "Pro/MiniMaxAI/MiniMax-M2.1",
      undefined,
      "off",
    );

    const model = {
      api: "openai-completions",
      provider: "siliconflow",
      id: "Pro/MiniMaxAI/MiniMax-M2.1",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.thinking).toBeNull();
  });

  it("keeps thinking=off unchanged for non-Pro SiliconFlow model IDs", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = { thinking: "off" };
      options?.onPayload?.(payload);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      undefined,
      "siliconflow",
      "deepseek-ai/DeepSeek-V3.2",
      undefined,
      "off",
    );

    const model = {
      api: "openai-completions",
      provider: "siliconflow",
      id: "deepseek-ai/DeepSeek-V3.2",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.thinking).toBe("off");
  });

  it("removes invalid negative Google thinkingBudget and maps Gemini 3.1 to thinkingLevel", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        contents: [
          {
            role: "user",
            parts: [
              { text: "describe image" },
              {
                inlineData: {
                  mimeType: "image/png",
                  data: "ZmFrZQ==",
                },
              },
            ],
          },
        ],
        config: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: -1,
          },
        },
      };
      options?.onPayload?.(payload);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "atproxy", "gemini-3.1-pro-high", undefined, "high");

    const model = {
      api: "google-generative-ai",
      provider: "atproxy",
      id: "gemini-3.1-pro-high",
    } as Model<"google-generative-ai">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    const thinkingConfig = (
      payloads[0]?.config as { thinkingConfig?: Record<string, unknown> } | undefined
    )?.thinkingConfig;
    expect(thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "HIGH",
    });
    expect(
      (
        payloads[0]?.contents as
          | Array<{ parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> }>
          | undefined
      )?.[0]?.parts?.[1]?.inlineData,
    ).toEqual({
      mimeType: "image/png",
      data: "ZmFrZQ==",
    });
  });

  it("keeps valid Google thinkingBudget unchanged", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        config: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: 2048,
          },
        },
      };
      options?.onPayload?.(payload);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "atproxy", "gemini-3.1-pro-high", undefined, "high");

    const model = {
      api: "google-generative-ai",
      provider: "atproxy",
      id: "gemini-3.1-pro-high",
    } as Model<"google-generative-ai">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.config).toEqual({
      thinkingConfig: {
        includeThoughts: true,
        thinkingBudget: 2048,
      },
    });
  });
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

  it("passes configured websocket transport through stream options", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai-codex/gpt-5.3-codex": {
              params: {
                transport: "websocket",
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "openai-codex", "gpt-5.3-codex");

    const model = {
      api: "openai-codex-responses",
      provider: "openai-codex",
      id: "gpt-5.3-codex",
    } as Model<"openai-codex-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.transport).toBe("websocket");
  });

  it("defaults Codex transport to auto (WebSocket-first)", () => {
    const { calls, agent } = createOptionsCaptureAgent();

    applyExtraParamsToAgent(agent, undefined, "openai-codex", "gpt-5.3-codex");

    const model = {
      api: "openai-codex-responses",
      provider: "openai-codex",
      id: "gpt-5.3-codex",
    } as Model<"openai-codex-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.transport).toBe("auto");
  });

  it("does not set transport defaults for non-Codex providers", () => {
    const { calls, agent } = createOptionsCaptureAgent();

    applyExtraParamsToAgent(agent, undefined, "openai", "gpt-5");

    const model = {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5",
    } as Model<"openai-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.transport).toBeUndefined();
  });

  it("allows forcing Codex transport to SSE", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai-codex/gpt-5.3-codex": {
              params: {
                transport: "sse",
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "openai-codex", "gpt-5.3-codex");

    const model = {
      api: "openai-codex-responses",
      provider: "openai-codex",
      id: "gpt-5.3-codex",
    } as Model<"openai-codex-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.transport).toBe("sse");
  });

  it("lets runtime options override configured transport", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai-codex/gpt-5.3-codex": {
              params: {
                transport: "websocket",
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "openai-codex", "gpt-5.3-codex");

    const model = {
      api: "openai-codex-responses",
      provider: "openai-codex",
      id: "gpt-5.3-codex",
    } as Model<"openai-codex-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, { transport: "sse" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.transport).toBe("sse");
  });

  it("falls back to Codex default transport when configured value is invalid", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai-codex/gpt-5.3-codex": {
              params: {
                transport: "udp",
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "openai-codex", "gpt-5.3-codex");

    const model = {
      api: "openai-codex-responses",
      provider: "openai-codex",
      id: "gpt-5.3-codex",
    } as Model<"openai-codex-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.transport).toBe("auto");
  });

  it("disables prompt caching for non-Anthropic Bedrock models", () => {
    const { calls, agent } = createOptionsCaptureAgent();

    applyExtraParamsToAgent(agent, undefined, "amazon-bedrock", "amazon.nova-micro-v1");

    const model = {
      api: "openai-completions",
      provider: "amazon-bedrock",
      id: "amazon.nova-micro-v1",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cacheRetention).toBe("none");
  });

  it("keeps Anthropic Bedrock models eligible for provider-side caching", () => {
    const { calls, agent } = createOptionsCaptureAgent();

    applyExtraParamsToAgent(agent, undefined, "amazon-bedrock", "us.anthropic.claude-sonnet-4-5");

    const model = {
      api: "openai-completions",
      provider: "amazon-bedrock",
      id: "us.anthropic.claude-sonnet-4-5",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cacheRetention).toBeUndefined();
  });

  it("passes through explicit cacheRetention for Anthropic Bedrock models", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "amazon-bedrock/us.anthropic.claude-opus-4-6-v1": {
              params: {
                cacheRetention: "long",
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "amazon-bedrock", "us.anthropic.claude-opus-4-6-v1");

    const model = {
      api: "openai-completions",
      provider: "amazon-bedrock",
      id: "us.anthropic.claude-opus-4-6-v1",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cacheRetention).toBe("long");
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

    // Simulate pi-agent-core passing apiKey in options (API key, not OAuth token)
    void agent.streamFn?.(model, context, {
      apiKey: "sk-ant-api03-test",
      headers: { "X-Custom": "1" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers).toEqual({
      "X-Custom": "1",
      // Includes pi-ai default betas (preserved to avoid overwrite) + context1m
      "anthropic-beta":
        "fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14,context-1m-2025-08-07",
    });
  });

  it("skips context1m beta for OAuth tokens but preserves OAuth-required betas", () => {
    const calls: Array<SimpleStreamOptions | undefined> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push(options);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": {
              params: {
                context1m: true,
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "anthropic", "claude-sonnet-4-6");

    const model = {
      api: "anthropic-messages",
      provider: "anthropic",
      id: "claude-sonnet-4-6",
    } as Model<"anthropic-messages">;
    const context: Context = { messages: [] };

    // Simulate pi-agent-core passing an OAuth token (sk-ant-oat-*) as apiKey
    void agent.streamFn?.(model, context, {
      apiKey: "sk-ant-oat01-test-oauth-token",
      headers: { "X-Custom": "1" },
    });

    expect(calls).toHaveLength(1);
    const betaHeader = calls[0]?.headers?.["anthropic-beta"] as string;
    // Must include the OAuth-required betas so they aren't stripped by pi-ai's mergeHeaders
    expect(betaHeader).toContain("oauth-2025-04-20");
    expect(betaHeader).toContain("claude-code-20250219");
    expect(betaHeader).not.toContain("context-1m-2025-08-07");
  });

  it("merges existing anthropic-beta headers with configured betas", () => {
    const cfg = buildAnthropicModelConfig("anthropic/claude-sonnet-4-5", {
      context1m: true,
      anthropicBeta: ["files-api-2025-04-14"],
    });
    const headers = runAnthropicHeaderCase({
      cfg,
      modelId: "claude-sonnet-4-5",
      options: {
        apiKey: "sk-ant-api03-test",
        headers: { "anthropic-beta": "prompt-caching-2024-07-31" },
      },
    });

    expect(headers).toEqual({
      "anthropic-beta":
        "prompt-caching-2024-07-31,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14,files-api-2025-04-14,context-1m-2025-08-07",
    });
  });

  it("ignores context1m for non-Opus/Sonnet Anthropic models", () => {
    const cfg = buildAnthropicModelConfig("anthropic/claude-haiku-3-5", { context1m: true });
    const headers = runAnthropicHeaderCase({
      cfg,
      modelId: "claude-haiku-3-5",
      options: { headers: { "X-Custom": "1" } },
    });
    expect(headers).toEqual({ "X-Custom": "1" });
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

  it.each([
    {
      name: "with openai-codex provider config",
      run: () =>
        runStoreMutationCase({
          applyProvider: "openai-codex",
          applyModelId: "codex-mini-latest",
          model: {
            api: "openai-codex-responses",
            provider: "openai-codex",
            id: "codex-mini-latest",
            baseUrl: "https://chatgpt.com/backend-api/codex/responses",
          } as Model<"openai-codex-responses">,
        }),
    },
    {
      name: "without config via provider/model hints",
      run: () =>
        runStoreMutationCase({
          applyProvider: "openai-codex",
          applyModelId: "codex-mini-latest",
          model: {
            api: "openai-codex-responses",
            provider: "openai-codex",
            id: "codex-mini-latest",
            baseUrl: "https://chatgpt.com/backend-api/codex/responses",
          } as Model<"openai-codex-responses">,
          options: {},
        }),
    },
  ])(
    "does not force store=true for Codex responses (Codex requires store=false) ($name)",
    ({ run }) => {
      expect(run().store).toBe(false);
    },
  );
});

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { applyExtraParamsToAgent, resolveExtraParams } from "./pi-embedded-runner.js";
import { log } from "./pi-embedded-runner/logger.js";

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

  it("preserves higher-precedence agent parallelToolCalls override across alias styles", () => {
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
    const calls: Array<(SimpleStreamOptions & { openaiWsWarmup?: boolean }) | undefined> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push(options as (SimpleStreamOptions & { openaiWsWarmup?: boolean }) | undefined);
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

  function runResponsesPayloadMutationCase(params: {
    applyProvider: string;
    applyModelId: string;
    model:
      | Model<"openai-responses">
      | Model<"openai-codex-responses">
      | Model<"openai-completions">
      | Model<"anthropic-messages">;
    options?: SimpleStreamOptions;
    cfg?: Record<string, unknown>;
    extraParamsOverride?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  }) {
    const payload = params.payload ?? { store: false };
    const baseStreamFn: StreamFn = (model, _context, options) => {
      options?.onPayload?.(payload, model);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };
    applyExtraParamsToAgent(
      agent,
      params.cfg as Parameters<typeof applyExtraParamsToAgent>[1],
      params.applyProvider,
      params.applyModelId,
      params.extraParamsOverride,
    );
    const context: Context = { messages: [] };
    void agent.streamFn?.(params.model, context, params.options ?? {});
    return payload;
  }

  function runParallelToolCallsPayloadMutationCase(params: {
    applyProvider: string;
    applyModelId: string;
    model: Model<"openai-completions"> | Model<"openai-responses"> | Model<"anthropic-messages">;
    cfg?: Record<string, unknown>;
    extraParamsOverride?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  }) {
    const payload = params.payload ?? {};
    const baseStreamFn: StreamFn = (model, _context, options) => {
      options?.onPayload?.(payload, model);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };
    applyExtraParamsToAgent(
      agent,
      params.cfg as Parameters<typeof applyExtraParamsToAgent>[1],
      params.applyProvider,
      params.applyModelId,
      params.extraParamsOverride,
    );
    const context: Context = { messages: [] };
    void agent.streamFn?.(params.model, context, {});
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
      options?.onPayload?.(payload, _model);
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
      options?.onPayload?.(payload, _model);
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
      options?.onPayload?.(payload, _model);
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
      options?.onPayload?.(payload, _model);
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

  it("does not inject reasoning.effort for x-ai/grok models on OpenRouter (#32039)", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = { reasoning_effort: "medium" };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      undefined,
      "openrouter",
      "x-ai/grok-4.1-fast",
      undefined,
      "medium",
    );

    const model = {
      api: "openai-completions",
      provider: "openrouter",
      id: "x-ai/grok-4.1-fast",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).not.toHaveProperty("reasoning");
    expect(payloads[0]).not.toHaveProperty("reasoning_effort");
  });

  it("injects parallel_tool_calls for openai-completions payloads when configured", () => {
    const payload = runParallelToolCallsPayloadMutationCase({
      applyProvider: "nvidia-nim",
      applyModelId: "moonshotai/kimi-k2.5",
      cfg: {
        agents: {
          defaults: {
            models: {
              "nvidia-nim/moonshotai/kimi-k2.5": {
                params: {
                  parallel_tool_calls: false,
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-completions",
        provider: "nvidia-nim",
        id: "moonshotai/kimi-k2.5",
      } as Model<"openai-completions">,
    });

    expect(payload.parallel_tool_calls).toBe(false);
  });

  it("injects parallel_tool_calls for openai-responses payloads when configured", () => {
    const payload = runParallelToolCallsPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5": {
                params: {
                  parallelToolCalls: true,
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api.openai.com/v1",
      } as unknown as Model<"openai-responses">,
    });

    expect(payload.parallel_tool_calls).toBe(true);
  });

  it("does not inject parallel_tool_calls for unsupported APIs", () => {
    const payload = runParallelToolCallsPayloadMutationCase({
      applyProvider: "anthropic",
      applyModelId: "claude-sonnet-4-6",
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": {
                params: {
                  parallel_tool_calls: false,
                },
              },
            },
          },
        },
      },
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-6",
      } as Model<"anthropic-messages">,
    });

    expect(payload).not.toHaveProperty("parallel_tool_calls");
  });

  it("lets runtime override win across alias styles for parallel_tool_calls", () => {
    const payload = runParallelToolCallsPayloadMutationCase({
      applyProvider: "nvidia-nim",
      applyModelId: "moonshotai/kimi-k2.5",
      cfg: {
        agents: {
          defaults: {
            models: {
              "nvidia-nim/moonshotai/kimi-k2.5": {
                params: {
                  parallel_tool_calls: true,
                },
              },
            },
          },
        },
      },
      extraParamsOverride: {
        parallelToolCalls: false,
      },
      model: {
        api: "openai-completions",
        provider: "nvidia-nim",
        id: "moonshotai/kimi-k2.5",
      } as Model<"openai-completions">,
    });

    expect(payload.parallel_tool_calls).toBe(false);
  });

  it("lets null runtime override suppress inherited parallel_tool_calls injection", () => {
    const payload = runParallelToolCallsPayloadMutationCase({
      applyProvider: "nvidia-nim",
      applyModelId: "moonshotai/kimi-k2.5",
      cfg: {
        agents: {
          defaults: {
            models: {
              "nvidia-nim/moonshotai/kimi-k2.5": {
                params: {
                  parallel_tool_calls: true,
                },
              },
            },
          },
        },
      },
      extraParamsOverride: {
        parallelToolCalls: null,
      },
      model: {
        api: "openai-completions",
        provider: "nvidia-nim",
        id: "moonshotai/kimi-k2.5",
      } as Model<"openai-completions">,
    });

    expect(payload).not.toHaveProperty("parallel_tool_calls");
  });

  it("warns and skips invalid parallel_tool_calls values", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const payload = runParallelToolCallsPayloadMutationCase({
        applyProvider: "nvidia-nim",
        applyModelId: "moonshotai/kimi-k2.5",
        cfg: {
          agents: {
            defaults: {
              models: {
                "nvidia-nim/moonshotai/kimi-k2.5": {
                  params: {
                    parallelToolCalls: "false",
                  },
                },
              },
            },
          },
        },
        model: {
          api: "openai-completions",
          provider: "nvidia-nim",
          id: "moonshotai/kimi-k2.5",
        } as Model<"openai-completions">,
      });

      expect(payload).not.toHaveProperty("parallel_tool_calls");
      expect(warnSpy).toHaveBeenCalledWith("ignoring invalid parallel_tool_calls param: false");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("normalizes thinking=off to null for SiliconFlow Pro models", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = { thinking: "off" };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      undefined,
      "siliconflow",
      "Pro/MiniMaxAI/MiniMax-M2.5",
      undefined,
      "off",
    );

    const model = {
      api: "openai-completions",
      provider: "siliconflow",
      id: "Pro/MiniMaxAI/MiniMax-M2.5",
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
      options?.onPayload?.(payload, _model);
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

  it("maps thinkingLevel=off to Moonshot thinking.type=disabled", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {};
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "moonshot", "kimi-k2.5", undefined, "off");

    const model = {
      api: "openai-completions",
      provider: "moonshot",
      id: "kimi-k2.5",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.thinking).toEqual({ type: "disabled" });
  });

  it("maps non-off thinking levels to Moonshot thinking.type=enabled and normalizes tool_choice", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = { tool_choice: "required" };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "moonshot", "kimi-k2.5", undefined, "low");

    const model = {
      api: "openai-completions",
      provider: "moonshot",
      id: "kimi-k2.5",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.thinking).toEqual({ type: "enabled" });
    expect(payloads[0]?.tool_choice).toBe("auto");
  });

  it("disables thinking instead of broadening pinned Moonshot tool_choice", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        tool_choice: { type: "tool", name: "read" },
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "moonshot", "kimi-k2.5", undefined, "low");

    const model = {
      api: "openai-completions",
      provider: "moonshot",
      id: "kimi-k2.5",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.thinking).toEqual({ type: "disabled" });
    expect(payloads[0]?.tool_choice).toEqual({ type: "tool", name: "read" });
  });

  it("respects explicit Moonshot thinking param from model config", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {};
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };
    const cfg = {
      agents: {
        defaults: {
          models: {
            "moonshot/kimi-k2.5": {
              params: {
                thinking: { type: "disabled" },
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "moonshot", "kimi-k2.5", undefined, "high");

    const model = {
      api: "openai-completions",
      provider: "moonshot",
      id: "kimi-k2.5",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.thinking).toEqual({ type: "disabled" });
  });

  it("applies Moonshot payload compatibility to Ollama Kimi cloud models", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = { tool_choice: "required" };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "ollama", "kimi-k2.5:cloud", undefined, "low");

    const model = {
      api: "openai-completions",
      provider: "ollama",
      id: "kimi-k2.5:cloud",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.thinking).toEqual({ type: "enabled" });
    expect(payloads[0]?.tool_choice).toBe("auto");
  });

  it("maps thinkingLevel=off for Ollama Kimi cloud models through Moonshot compatibility", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {};
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "ollama", "kimi-k2.5:cloud", undefined, "off");

    const model = {
      api: "openai-completions",
      provider: "ollama",
      id: "kimi-k2.5:cloud",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.thinking).toEqual({ type: "disabled" });
  });

  it("disables thinking instead of broadening pinned Ollama Kimi cloud tool_choice", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        tool_choice: { type: "function", function: { name: "read" } },
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "ollama", "kimi-k2.5:cloud", undefined, "low");

    const model = {
      api: "openai-completions",
      provider: "ollama",
      id: "kimi-k2.5:cloud",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.thinking).toEqual({ type: "disabled" });
    expect(payloads[0]?.tool_choice).toEqual({
      type: "function",
      function: { name: "read" },
    });
  });

  it("does not rewrite tool schema for kimi-coding (native Anthropic format)", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        tools: [
          {
            name: "read",
            description: "Read file",
            input_schema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
        tool_choice: { type: "tool", name: "read" },
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "kimi-coding", "k2p5", undefined, "low");

    const model = {
      api: "anthropic-messages",
      provider: "kimi-coding",
      id: "k2p5",
      baseUrl: "https://api.kimi.com/coding/",
    } as Model<"anthropic-messages">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.tools).toEqual([
      {
        name: "read",
        description: "Read file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ]);
    expect(payloads[0]?.tool_choice).toEqual({ type: "tool", name: "read" });
  });

  it("does not rewrite anthropic tool schema for non-kimi endpoints", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        tools: [
          {
            name: "read",
            description: "Read file",
            input_schema: { type: "object", properties: {} },
          },
        ],
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "anthropic", "claude-sonnet-4-6", undefined, "low");

    const model = {
      api: "anthropic-messages",
      provider: "anthropic",
      id: "claude-sonnet-4-6",
      baseUrl: "https://api.anthropic.com",
    } as Model<"anthropic-messages">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.tools).toEqual([
      {
        name: "read",
        description: "Read file",
        input_schema: { type: "object", properties: {} },
      },
    ]);
  });

  it("uses explicit compat metadata for anthropic tool payload normalization", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        tools: [
          {
            name: "read",
            description: "Read file",
            input_schema: { type: "object", properties: {} },
          },
        ],
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      undefined,
      "custom-anthropic-proxy",
      "proxy-model",
      undefined,
      "low",
    );

    const model = {
      api: "anthropic-messages",
      provider: "custom-anthropic-proxy",
      id: "proxy-model",
      compat: {
        requiresOpenAiAnthropicToolPayload: true,
      },
    } as unknown as Model<"anthropic-messages">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read",
          description: "Read file",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
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
      options?.onPayload?.(payload, _model);
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
      options?.onPayload?.(payload, _model);
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

  it("passes configured websocket transport through stream options for openai-codex gpt-5.4", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai-codex/gpt-5.4": {
              params: {
                transport: "websocket",
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "openai-codex", "gpt-5.4");

    const model = {
      api: "openai-codex-responses",
      provider: "openai-codex",
      id: "gpt-5.4",
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

  it("defaults OpenAI transport to auto (WebSocket-first)", () => {
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
    expect(calls[0]?.transport).toBe("auto");
    expect(calls[0]?.openaiWsWarmup).toBe(false);
  });

  it("lets runtime options override OpenAI default transport", () => {
    const { calls, agent } = createOptionsCaptureAgent();

    applyExtraParamsToAgent(agent, undefined, "openai", "gpt-5");

    const model = {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5",
    } as Model<"openai-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, { transport: "sse" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.transport).toBe("sse");
  });

  it("allows disabling OpenAI websocket warm-up via model params", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5": {
              params: {
                openaiWsWarmup: false,
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "openai", "gpt-5");

    const model = {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5",
    } as Model<"openai-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.openaiWsWarmup).toBe(false);
  });

  it("lets runtime options override configured OpenAI websocket warm-up", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5": {
              params: {
                openaiWsWarmup: false,
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "openai", "gpt-5");

    const model = {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5",
    } as Model<"openai-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {
      openaiWsWarmup: true,
    } as unknown as SimpleStreamOptions);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.openaiWsWarmup).toBe(true);
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
      apiKey: "sk-ant-api03-test", // pragma: allowlist secret
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

  it("injects pi-ai default betas even when context1m is not enabled", () => {
    const cfg = buildAnthropicModelConfig("anthropic/claude-opus-4-6", {
      temperature: 0.2,
    });
    const headers = runAnthropicHeaderCase({
      cfg,
      modelId: "claude-opus-4-6",
      options: { headers: { "X-Custom": "1" } },
    });

    expect(headers).toEqual({
      "X-Custom": "1",
      "anthropic-beta": "fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14",
    });
  });

  it("injects OAuth betas for sk-ant-oat tokens even without context1m", () => {
    const cfg = buildAnthropicModelConfig("anthropic/claude-opus-4-6", {
      temperature: 0.2,
    });
    const headers = runAnthropicHeaderCase({
      cfg,
      modelId: "claude-opus-4-6",
      options: {
        apiKey: "sk-ant-oat01-test-oauth-token", // pragma: allowlist secret
        headers: { "X-Custom": "1" },
      },
    });

    const betaHeader = headers?.["anthropic-beta"] as string;
    expect(betaHeader).toContain("oauth-2025-04-20");
    expect(betaHeader).toContain("claude-code-20250219");
    expect(betaHeader).not.toContain("context-1m-2025-08-07");
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
      apiKey: "sk-ant-oat01-test-oauth-token", // pragma: allowlist secret
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
        apiKey: "sk-ant-api03-test", // pragma: allowlist secret
        headers: { "anthropic-beta": "prompt-caching-2024-07-31" },
      },
    });

    expect(headers).toEqual({
      "anthropic-beta":
        "prompt-caching-2024-07-31,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14,files-api-2025-04-14,context-1m-2025-08-07",
    });
  });

  it("ignores context1m for non-Opus/Sonnet Anthropic models but still injects default betas", () => {
    const cfg = buildAnthropicModelConfig("anthropic/claude-haiku-3-5", { context1m: true });
    const headers = runAnthropicHeaderCase({
      cfg,
      modelId: "claude-haiku-3-5",
      options: { headers: { "X-Custom": "1" } },
    });
    expect(headers).toEqual({
      "X-Custom": "1",
      "anthropic-beta": "fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14",
    });
  });

  it("forces store=true for direct OpenAI Responses payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api.openai.com/v1",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload.store).toBe(true);
  });

  it("forces store=true for azure-openai provider with openai-responses API (#42800)", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "azure-openai",
      applyModelId: "gpt-5-mini",
      model: {
        api: "openai-responses",
        provider: "azure-openai",
        id: "gpt-5-mini",
        baseUrl: "https://myresource.openai.azure.com/openai/v1",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload.store).toBe(true);
  });

  it("injects configured OpenAI service_tier into Responses payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  serviceTier: "priority",
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload.service_tier).toBe("priority");
  });

  it("preserves caller-provided service_tier values", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  serviceTier: "priority",
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as unknown as Model<"openai-responses">,
      payload: {
        store: false,
        service_tier: "default",
      },
    });
    expect(payload.service_tier).toBe("default");
  });

  it("injects fast-mode payload defaults for direct OpenAI Responses", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  fastMode: true,
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as unknown as Model<"openai-responses">,
      payload: {
        store: false,
      },
    });
    expect(payload.reasoning).toEqual({ effort: "low" });
    expect(payload.text).toEqual({ verbosity: "low" });
    expect(payload.service_tier).toBe("priority");
  });

  it("preserves caller-provided OpenAI payload fields when fast mode is enabled", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as unknown as Model<"openai-responses">,
      payload: {
        reasoning: { effort: "medium" },
        text: { verbosity: "high" },
        service_tier: "default",
      },
    });
    expect(payload.reasoning).toEqual({ effort: "medium" });
    expect(payload.text).toEqual({ verbosity: "high" });
    expect(payload.service_tier).toBe("default");
  });

  it("injects service_tier=auto for Anthropic fast mode on direct API-key models", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "anthropic",
      applyModelId: "claude-sonnet-4-5",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        baseUrl: "https://api.anthropic.com",
      } as unknown as Model<"anthropic-messages">,
      payload: {},
    });
    expect(payload.service_tier).toBe("auto");
  });

  it("injects service_tier=standard_only for Anthropic fast mode off", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "anthropic",
      applyModelId: "claude-sonnet-4-5",
      extraParamsOverride: { fastMode: false },
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        baseUrl: "https://api.anthropic.com",
      } as unknown as Model<"anthropic-messages">,
      payload: {},
    });
    expect(payload.service_tier).toBe("standard_only");
  });

  it("preserves caller-provided Anthropic service_tier values", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "anthropic",
      applyModelId: "claude-sonnet-4-5",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        baseUrl: "https://api.anthropic.com",
      } as unknown as Model<"anthropic-messages">,
      payload: {
        service_tier: "standard_only",
      },
    });
    expect(payload.service_tier).toBe("standard_only");
  });

  it("does not inject Anthropic fast mode service_tier for OAuth auth", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "anthropic",
      applyModelId: "claude-sonnet-4-5",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        baseUrl: "https://api.anthropic.com",
      } as unknown as Model<"anthropic-messages">,
      options: {
        apiKey: "sk-ant-oat-test-token",
      },
      payload: {},
    });
    expect(payload).not.toHaveProperty("service_tier");
  });

  it("does not inject Anthropic fast mode service_tier for proxied base URLs", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "anthropic",
      applyModelId: "claude-sonnet-4-5",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        baseUrl: "https://proxy.example.com/anthropic",
      } as unknown as Model<"anthropic-messages">,
      payload: {},
    });
    expect(payload).not.toHaveProperty("service_tier");
  });

  it("applies fast-mode defaults for openai-codex responses without service_tier", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai-codex",
      applyModelId: "gpt-5.4",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "gpt-5.4",
        baseUrl: "https://chatgpt.com/backend-api",
      } as unknown as Model<"openai-codex-responses">,
      payload: {
        store: false,
      },
    });
    expect(payload.reasoning).toEqual({ effort: "low" });
    expect(payload.text).toEqual({ verbosity: "low" });
    expect(payload).not.toHaveProperty("service_tier");
  });

  it("does not inject service_tier for non-openai providers", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "azure-openai-responses",
      applyModelId: "gpt-5.4",
      cfg: {
        agents: {
          defaults: {
            models: {
              "azure-openai-responses/gpt-5.4": {
                params: {
                  serviceTier: "priority",
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        provider: "azure-openai-responses",
        id: "gpt-5.4",
        baseUrl: "https://example.openai.azure.com/openai/v1",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload).not.toHaveProperty("service_tier");
  });

  it("does not inject service_tier for proxied openai base URLs", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  serviceTier: "priority",
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://proxy.example.com/v1",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload).not.toHaveProperty("service_tier");
  });

  it("does not inject service_tier for openai provider routed to Azure base URLs", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  serviceTier: "priority",
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://example.openai.azure.com/openai/v1",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload).not.toHaveProperty("service_tier");
  });

  it("warns and skips service_tier injection for invalid serviceTier values", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const payload = runResponsesPayloadMutationCase({
        applyProvider: "openai",
        applyModelId: "gpt-5.4",
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.4": {
                  params: {
                    serviceTier: "invalid",
                  },
                },
              },
            },
          },
        },
        model: {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
          baseUrl: "https://api.openai.com/v1",
        } as unknown as Model<"openai-responses">,
      });

      expect(payload).not.toHaveProperty("service_tier");
      expect(warnSpy).toHaveBeenCalledWith("ignoring invalid OpenAI service tier param: invalid");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not force store for OpenAI Responses routed through non-OpenAI base URLs", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://proxy.example.com/v1",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload.store).toBe(false);
  });

  it("does not force store for OpenAI Responses when baseUrl is empty", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload.store).toBe(false);
  });

  it("strips store from payload for models that declare supportsStore=false", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "azure-openai-responses",
      applyModelId: "gpt-4o",
      model: {
        api: "openai-responses",
        provider: "azure-openai-responses",
        id: "gpt-4o",
        name: "gpt-4o",
        baseUrl: "https://example.openai.azure.com/openai/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
        compat: { supportsStore: false },
      } as unknown as Model<"openai-responses">,
    });
    expect(payload).not.toHaveProperty("store");
  });

  it("strips store from payload for non-OpenAI responses providers with supportsStore=false", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "custom-openai-responses",
      applyModelId: "gemini-2.5-pro",
      model: {
        api: "openai-responses",
        provider: "custom-openai-responses",
        id: "gemini-2.5-pro",
        name: "gemini-2.5-pro",
        baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/openai",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 65_536,
        compat: { supportsStore: false },
      } as unknown as Model<"openai-responses">,
    });
    expect(payload).not.toHaveProperty("store");
  });

  it("keeps existing context_management when stripping store for supportsStore=false models", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "custom-openai-responses",
      applyModelId: "gemini-2.5-pro",
      model: {
        api: "openai-responses",
        provider: "custom-openai-responses",
        id: "gemini-2.5-pro",
        name: "gemini-2.5-pro",
        baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/openai",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 65_536,
        compat: { supportsStore: false },
      } as unknown as Model<"openai-responses">,
      payload: {
        store: false,
        context_management: [{ type: "compaction", compact_threshold: 12_345 }],
      },
    });
    expect(payload).not.toHaveProperty("store");
    expect(payload.context_management).toEqual([{ type: "compaction", compact_threshold: 12_345 }]);
  });

  it("auto-injects OpenAI Responses context_management compaction for direct OpenAI models", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 200_000,
      } as unknown as Model<"openai-responses">,
    });
    expect(payload.context_management).toEqual([
      {
        type: "compaction",
        compact_threshold: 140_000,
      },
    ]);
  });

  it("does not auto-inject OpenAI Responses context_management for Azure by default", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "azure-openai-responses",
      applyModelId: "gpt-4o",
      model: {
        api: "openai-responses",
        provider: "azure-openai-responses",
        id: "gpt-4o",
        baseUrl: "https://example.openai.azure.com/openai/v1",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload).not.toHaveProperty("context_management");
  });

  it("allows explicitly enabling OpenAI Responses context_management compaction", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "azure-openai-responses",
      applyModelId: "gpt-4o",
      cfg: {
        agents: {
          defaults: {
            models: {
              "azure-openai-responses/gpt-4o": {
                params: {
                  responsesServerCompaction: true,
                  responsesCompactThreshold: 42_000,
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        provider: "azure-openai-responses",
        id: "gpt-4o",
        baseUrl: "https://example.openai.azure.com/openai/v1",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload.context_management).toEqual([
      {
        type: "compaction",
        compact_threshold: 42_000,
      },
    ]);
  });

  it("preserves existing context_management payload values", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api.openai.com/v1",
      } as unknown as Model<"openai-responses">,
      payload: {
        store: false,
        context_management: [{ type: "compaction", compact_threshold: 12_345 }],
      },
    });
    expect(payload.context_management).toEqual([{ type: "compaction", compact_threshold: 12_345 }]);
  });

  it("allows disabling OpenAI Responses context_management compaction via model params", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5": {
                params: {
                  responsesServerCompaction: false,
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api.openai.com/v1",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload).not.toHaveProperty("context_management");
  });

  it.each([
    {
      name: "with openai-codex provider config",
      run: () =>
        runResponsesPayloadMutationCase({
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
        runResponsesPayloadMutationCase({
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

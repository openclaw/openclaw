// Openrouter tests cover index plugin behavior.
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expectPassthroughReplayPolicy } from "openclaw/plugin-sdk/provider-test-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getLoadedOpenRouterModelCapabilitiesMock, loadOpenRouterModelCapabilitiesMock } =
  vi.hoisted(() => ({
    getLoadedOpenRouterModelCapabilitiesMock: vi.fn(),
    loadOpenRouterModelCapabilitiesMock: vi.fn(async () => {}),
  }));

vi.mock("openclaw/plugin-sdk/provider-stream-family", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/provider-stream-family")>();
  return {
    ...actual,
    getLoadedOpenRouterModelCapabilities: getLoadedOpenRouterModelCapabilitiesMock,
    loadOpenRouterModelCapabilities: loadOpenRouterModelCapabilitiesMock,
  };
});

import openrouterPlugin from "./index.js";
import * as openRouterCatalog from "./provider-catalog.js";
import { buildOpenrouterProvider } from "./provider-catalog.js";
import { resolveThinkingProfile } from "./provider-policy-api.js";

function createOpenRouterDoneStreamWithoutGeneration() {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        api: "openai-completions",
        provider: "openrouter",
        model: "openrouter/auto",
        content: [{ type: "text", text: "ok" }],
        stopReason: "stop",
        timestamp: Date.now(),
      } as never,
    });
  });
  return stream;
}

async function captureOpenRouterWrappedPayload(params: {
  modelId: string;
  thinkingLevel: string;
  payload: Record<string, unknown>;
  baseUrl?: string;
  forwardPayload?: boolean;
}) {
  const provider = await registerSingleProviderPlugin(openrouterPlugin);
  let capturedPayload: Record<string, unknown> | undefined;
  const baseStreamFn = vi.fn(
    (
      ...args: Parameters<import("openclaw/plugin-sdk/agent-core").StreamFn>
    ): ReturnType<import("openclaw/plugin-sdk/agent-core").StreamFn> => {
      void args[2]?.onPayload?.(params.payload, args[0]);
      if (!params.forwardPayload) {
        capturedPayload = params.payload;
      }
      return { async *[Symbol.asyncIterator]() {} } as never;
    },
  );
  const wrapped = provider.wrapStreamFn?.({
    provider: "openrouter",
    modelId: params.modelId,
    streamFn: baseStreamFn,
    thinkingLevel: params.thinkingLevel,
  } as never);
  void wrapped?.(
    {
      provider: "openrouter",
      api: "openai-completions",
      id: params.modelId,
      ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
      compat: {},
    } as never,
    { messages: [] } as never,
    (params.forwardPayload
      ? {
          onPayload: (payload: unknown) => {
            capturedPayload = payload as Record<string, unknown>;
            return payload;
          },
        }
      : {}) as never,
  );
  expect(baseStreamFn).toHaveBeenCalledOnce();
  return capturedPayload;
}

describe("openrouter provider hooks", () => {
  beforeEach(() => {
    getLoadedOpenRouterModelCapabilitiesMock.mockReset();
    loadOpenRouterModelCapabilitiesMock.mockClear();
  });

  it("forwards configured proxy destination and request policy into authenticated catalog discovery", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const configuredProvider = {
      apiKey: "synthetic-private-proxy-key",
      baseUrl: "https://private.example.invalid/router/v1///",
      request: { headers: { "X-Private-Proxy-Tenant": "synthetic-tenant" } },
      models: [],
    };
    const catalogSpy = vi
      .spyOn(openRouterCatalog, "buildOpenrouterLiveProvider")
      .mockResolvedValue(buildOpenrouterProvider());

    try {
      await provider.catalog?.run({
        config: { models: { providers: { openrouter: configuredProvider } } },
        resolveProviderApiKey: () => ({
          apiKey: "OPENROUTER_API_KEY",
          discoveryApiKey: "synthetic-private-proxy-key",
        }),
      } as never);

      expect(catalogSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: configuredProvider.baseUrl,
          request: configuredProvider.request,
        }),
      );
    } finally {
      catalogSpy.mockRestore();
    }
  });

  it("keeps dynamic proxy models on their configured credential destination", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const model = provider.resolveDynamicModel?.({
      provider: "openrouter",
      modelId: "private/unknown-model",
      modelRegistry: { find: vi.fn(() => null) },
      providerConfig: { baseUrl: "https://private.example.invalid/router/v1///" },
    } as never);

    expect(model?.baseUrl).toBe("https://private.example.invalid/router/v1");
  });

  it("resolves dynamic proxy destinations from canonical provider config when runtime config is absent", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const model = provider.resolveDynamicModel?.({
      provider: "openrouter",
      modelId: "private/unknown-model",
      modelRegistry: { find: vi.fn(() => null) },
      config: {
        models: {
          providers: {
            openrouter: { baseUrl: "https://private.example.invalid/router/v1/", models: [] },
          },
        },
      },
    } as never);

    expect(model?.baseUrl).toBe("https://private.example.invalid/router/v1");
  });

  it("preserves the canonical official destination for dynamically resolved default models", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const model = provider.resolveDynamicModel?.({
      provider: "openrouter",
      modelId: "openrouter/auto",
      modelRegistry: { find: vi.fn(() => null) },
      providerConfig: { baseUrl: "https://openrouter.ai/v1///" },
    } as never);

    expect(model?.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("forwards configured proxy destination and headers to both usage requests", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ data: { usage: 1 } }));

    await provider.fetchUsageSnapshot?.({
      config: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://private.example.invalid/router/v1///",
              request: { headers: { "X-Private-Proxy-Tenant": "synthetic-tenant" } },
              models: [],
            },
          },
        },
      },
      env: {},
      provider: "openrouter",
      token: "synthetic-private-proxy-key",
      timeoutMs: 5000,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      "https://private.example.invalid/router/v1/credits",
      "https://private.example.invalid/router/v1/key",
    ]);
    for (const [, options] of fetchFn.mock.calls) {
      expect(new Headers(options?.headers).get("x-private-proxy-tenant")).toBe("synthetic-tenant");
    }
  });

  it("does not start authenticated catalog discovery when no credential exists", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const catalogSpy = vi.spyOn(openRouterCatalog, "buildOpenrouterLiveProvider");

    try {
      await expect(
        provider.catalog?.run({
          config: {
            models: {
              providers: {
                openrouter: { baseUrl: "https://private.example.invalid/v1", models: [] },
              },
            },
          },
          resolveProviderApiKey: () => ({}),
        } as never),
      ).resolves.toBeNull();
      expect(catalogSpy).not.toHaveBeenCalled();
    } finally {
      catalogSpy.mockRestore();
    }
  });

  it("normalizes OpenRouter API ids before capability loading and lookup", async () => {
    getLoadedOpenRouterModelCapabilitiesMock.mockReturnValue({
      name: "Claude Sonnet 4.6",
      reasoning: true,
      compat: { supportedReasoningEfforts: ["high", "low"] },
      thinkingLevelMap: { off: null },
      input: ["text", "image"],
      supportsTools: true,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    });
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const modelId = "openrouter/anthropic/claude-sonnet-4.6";
    const context = {
      provider: "openrouter",
      modelId,
      modelRegistry: { find: vi.fn(() => null) },
    } as never;

    await provider.prepareDynamicModel?.(context);
    const model = provider.resolveDynamicModel?.(context);

    expect(loadOpenRouterModelCapabilitiesMock).toHaveBeenCalledWith("anthropic/claude-sonnet-4.6");
    expect(getLoadedOpenRouterModelCapabilitiesMock).toHaveBeenCalledWith(
      "anthropic/claude-sonnet-4.6",
    );
    expect(model).toMatchObject({
      id: modelId,
      name: "Claude Sonnet 4.6",
      reasoning: true,
      input: ["text", "image"],
      compat: { supportsTools: true, supportedReasoningEfforts: ["high", "low"] },
      thinkingLevelMap: { off: null },
      contextWindow: 200_000,
      maxTokens: 64_000,
    });
  });

  it("owns passthrough-gemini replay policy for Gemini-backed models", async () => {
    await expectPassthroughReplayPolicy({
      plugin: openrouterPlugin,
      providerId: "openrouter",
      modelId: "gemini-2.5-pro",
      sanitizeThoughtSignatures: true,
    });
    await expectPassthroughReplayPolicy({
      plugin: openrouterPlugin,
      providerId: "openrouter",
      modelId: "openai/gpt-5.4",
    });
  });

  // Regression for #58012: OpenRouter proxies Mistral, which requires the
  // strict9 tool_call_id mode the direct `mistral` provider already applies.
  // Without strict9, replayed assistant turns fail with HTTP 400
  // `invalid_function_call` 3280. Other OpenRouter-routed models (Gemini,
  // OpenAI, Anthropic, etc.) must keep the existing passthrough policy.
  describe("OpenRouter Mistral tool_call_id strict9 (#58012)", () => {
    it.each([["unprefixed Mistral", "mistral-large-latest"]])(
      "applies strict9 sanitisation for %s",
      async (_label, modelId) => {
        const provider = await registerSingleProviderPlugin(openrouterPlugin);
        const policy = provider.buildReplayPolicy?.({
          provider: "openrouter",
          modelApi: "openai-completions",
          modelId,
        } as never);

        expect(policy?.sanitizeToolCallIds).toBe(true);
        expect(policy?.toolCallIdMode).toBe("strict9");
      },
    );
  });

  it("owns native reasoning output mode", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);

    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "openrouter",
        modelApi: "openai-completions",
        modelId: "openai/gpt-5.4",
      } as never),
    ).toBe("native");
  });

  it("advertises xhigh thinking for OpenRouter-routed DeepSeek V4 models", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const expectedV4Levels = ["off", "minimal", "low", "medium", "high", "xhigh"];

    expect(
      provider
        .resolveThinkingProfile?.({
          provider: "openrouter",
          modelId: "deepseek/deepseek-v4-pro",
        } as never)
        ?.levels.map((level) => level.id),
    ).toEqual(expectedV4Levels);
    expect(
      provider.resolveThinkingProfile?.({
        provider: "openrouter",
        modelId: "openrouter/deepseek/deepseek-v4-flash",
      } as never)?.defaultLevel,
    ).toBe("high");
    expect(
      provider.resolveThinkingProfile?.({
        provider: "openrouter",
        modelId: "openai/gpt-5.4",
      } as never),
    ).toBe(undefined);
  });

  it("exposes DeepSeek V4 thinking levels through the lightweight policy artifact", () => {
    expect(
      resolveThinkingProfile({
        provider: "openrouter",
        modelId: "openrouter/deepseek/deepseek-v4-pro",
      })?.levels.map((level) => level.id),
    ).toContain("xhigh");
    expect(
      resolveThinkingProfile({
        provider: "openrouter",
        modelId: "openai/gpt-5.4",
      }),
    ).toBe(undefined);
  });

  it("canonicalizes stale OpenRouter /v1 config and runtime metadata", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);

    const normalizedConfig = provider.normalizeConfig?.({
      provider: "openrouter",
      providerConfig: {
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/v1/",
        models: [],
      },
    } as never);
    expect(normalizedConfig?.baseUrl).toBe("https://openrouter.ai/api/v1");

    const normalizedGptModel = provider.normalizeResolvedModel?.({
      provider: "openrouter",
      model: {
        provider: "openrouter",
        id: "openai/gpt-5.4",
        name: "openai/gpt-5.4",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8192,
      },
    } as never);
    expect(normalizedGptModel?.baseUrl).toBe("https://openrouter.ai/api/v1");

    const normalizedHunterModel = provider.normalizeResolvedModel?.({
      provider: "openrouter",
      model: {
        provider: "openrouter",
        id: "openrouter/hunter-alpha",
        name: "Hunter Alpha",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_048_576,
        maxTokens: 65_536,
      },
    } as never);
    expect(normalizedHunterModel?.reasoning).toBe(false);
    expect(normalizedHunterModel?.id).toBe("openrouter/hunter-alpha");

    const normalizedAnthropicModel = provider.normalizeResolvedModel?.({
      provider: "openrouter",
      model: {
        provider: "openrouter",
        id: "openrouter/anthropic/claude-sonnet-4.6",
        name: "anthropic/claude-sonnet-4.6",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8192,
      },
    } as never);
    expect(normalizedAnthropicModel?.id).toBe("anthropic/claude-sonnet-4.6");

    const autoModel = {
      provider: "openrouter",
      id: "openrouter/auto",
      name: "OpenRouter Auto",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8192,
    };
    expect(
      provider.normalizeResolvedModel?.({
        provider: "openrouter",
        modelId: "openrouter/auto",
        model: autoModel,
      } as never),
    ).toBeUndefined();

    const normalizedDuplicatedAutoModel = provider.normalizeResolvedModel?.({
      provider: "openrouter",
      modelId: "openrouter/openrouter/auto",
      model: {
        ...autoModel,
        id: "openrouter/openrouter/auto",
      },
    } as never);
    expect(normalizedDuplicatedAutoModel?.id).toBe("openrouter/auto");

    expect(
      provider.normalizeTransport?.({
        provider: "openrouter",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/v1",
      } as never),
    ).toEqual({
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });

  it("injects provider routing into compat before applying stream wrappers", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn = vi.fn(
      (
        ...args: Parameters<import("openclaw/plugin-sdk/agent-core").StreamFn>
      ): ReturnType<import("openclaw/plugin-sdk/agent-core").StreamFn> => {
        const payload: Record<string, unknown> = {};
        void args[2]?.onPayload?.(payload, args[0]);
        capturedPayload = payload;
        return { async *[Symbol.asyncIterator]() {} } as never;
      },
    );

    const wrapped = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "openai/gpt-5.4",
      extraParams: {
        provider: {
          order: ["moonshot"],
        },
      },
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never);

    void wrapped?.(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "openai/gpt-5.4",
        compat: {},
      } as never,
      { messages: [] } as never,
      {},
    );

    expect(baseStreamFn).toHaveBeenCalledOnce();
    const firstCall = baseStreamFn.mock.calls[0];
    const firstModel = firstCall?.[0];
    const compat = (firstModel as { compat?: { openRouterRouting?: { order?: unknown } } }).compat;
    expect(compat?.openRouterRouting?.order).toEqual(["moonshot"]);
    expect(capturedPayload?.provider).toEqual({
      order: ["moonshot"],
    });
  });

  it("forwards resolved API keys as explicit OpenRouter auth headers", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const baseStreamFn = vi.fn((..._args: unknown[]) =>
      createOpenRouterDoneStreamWithoutGeneration(),
    );

    const wrapped = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "openrouter/auto",
      streamFn: baseStreamFn,
    } as never);
    if (!wrapped) {
      throw new Error("expected OpenRouter wrapper");
    }

    const stream = await wrapped(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "openrouter/auto",
        baseUrl: "https://openrouter.ai/api/v1",
        compat: {},
      } as never,
      { messages: [] } as never,
      { apiKey: "or-test-key" } as never,
    );
    await stream.result();

    expect(baseStreamFn).toHaveBeenCalledOnce();
    const options = baseStreamFn.mock.calls[0]?.[2] as { headers?: HeadersInit } | undefined;
    const headers = new Headers(options?.headers);
    expect(headers.get("authorization")).toBe("Bearer or-test-key");
  });

  it("merges resolved OpenRouter model params into transport params", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const patch = provider.extraParamsForTransport?.({
      config: {
        models: {
          providers: {
            openrouter: {
              params: {
                provider: {
                  sort: "price",
                  data_collection: "deny",
                },
              },
            },
          },
        },
      },
      provider: "openrouter",
      modelId: "openai/gpt-5.4",
      extraParams: {
        provider: {
          sort: "latency",
          require_parameters: true,
        },
        temperature: 0.2,
      },
      model: {
        provider: "openrouter",
        api: "openai-completions",
        id: "openai/gpt-5.4",
        params: {
          responseCache: true,
          provider: {
            order: ["openai"],
            constructor: "ignored",
          },
        },
      },
      transport: "sse",
    } as never)?.patch;

    expect(patch?.responseCache).toBe(true);
    expect(patch?.temperature).toBe(0.2);
    expect(patch?.provider).toEqual({
      sort: "latency",
      data_collection: "deny",
      order: ["openai"],
      require_parameters: true,
    });
  });

  it("does not inject OpenRouter reasoning for Hunter Alpha", async () => {
    const capturedPayload = await captureOpenRouterWrappedPayload({
      modelId: "openrouter/hunter-alpha",
      thinkingLevel: "high",
      payload: {},
      forwardPayload: true,
    });
    expect(capturedPayload).toStrictEqual({});
  });

  it("recognizes full OpenRouter DeepSeek V4 refs but skips custom proxy routes", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn = vi.fn(
      (
        ...args: Parameters<import("openclaw/plugin-sdk/agent-core").StreamFn>
      ): ReturnType<import("openclaw/plugin-sdk/agent-core").StreamFn> => {
        const payload = {
          messages: [{ role: "assistant", tool_calls: [{ id: "call_1", type: "function" }] }],
        };
        void args[2]?.onPayload?.(payload, args[0]);
        payloads.push(payload);
        return { async *[Symbol.asyncIterator]() {} } as never;
      },
    );

    const fullRef = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "openrouter/deepseek/deepseek-v4-pro",
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never);
    void fullRef?.(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "openrouter/deepseek/deepseek-v4-pro",
        baseUrl: "https://openrouter.ai/api/v1",
        compat: {},
      } as never,
      { messages: [] } as never,
      {},
    );

    const customRoute = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4-pro",
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never);
    void customRoute?.(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "deepseek/deepseek-v4-pro",
        baseUrl: "https://proxy.example.com/v1",
        compat: {},
      } as never,
      { messages: [] } as never,
      {},
    );

    expect(payloads[0]?.messages).toEqual([
      {
        role: "assistant",
        tool_calls: [{ id: "call_1", type: "function" }],
      },
    ]);
    expect(payloads[1]?.messages).toEqual([
      { role: "assistant", tool_calls: [{ id: "call_1", type: "function" }] },
    ]);
  });

  it("strips OpenRouter-routed Anthropic assistant prefill when reasoning is enabled", async () => {
    const capturedPayload = await captureOpenRouterWrappedPayload({
      modelId: "anthropic/claude-opus-4.6",
      thinkingLevel: "high",
      baseUrl: "https://openrouter.ai/api/v1",
      payload: {
        messages: [
          { role: "user", content: "Return JSON." },
          { role: "assistant", content: "{" },
        ],
      },
    });
    expect(capturedPayload?.messages).toEqual([{ role: "user", content: "Return JSON." }]);
    expect(capturedPayload?.reasoning).toEqual({ effort: "high" });
  });
});

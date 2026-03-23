import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pi-model-discovery.js", () => ({
  discoverAuthStorage: vi.fn(() => ({ mocked: true })),
  discoverModels: vi.fn(() => ({ find: vi.fn(() => null) })),
}));

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_FALLBACK_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

import type { OpenRouterModelCapabilities } from "./openrouter-model-capabilities.js";

const mockGetOpenRouterModelCapabilities = vi.fn<
  (modelId: string) => OpenRouterModelCapabilities | undefined
>(() => undefined);
const mockLoadOpenRouterModelCapabilities = vi.fn<(modelId: string) => Promise<void>>(
  async () => {},
);
vi.mock("./openrouter-model-capabilities.js", () => ({
  getOpenRouterModelCapabilities: (modelId: string) => mockGetOpenRouterModelCapabilities(modelId),
  loadOpenRouterModelCapabilities: (modelId: string) =>
    mockLoadOpenRouterModelCapabilities(modelId),
}));

vi.mock("../../plugins/provider-runtime.js", () => {
  const HANDLED_DYNAMIC_PROVIDERS = new Set([
    "openrouter",
    "github-copilot",
    "openai-codex",
    "openai",
    "anthropic",
    "zai",
  ]);
  const OPENAI_BASE_URL = "https://api.openai.com/v1";
  const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
  const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
  const ZAI_BASE_URL = "https://api.z.ai/api/paas/v4";
  const DEFAULT_CONTEXT_WINDOW = 200_000;
  const DEFAULT_MAX_TOKENS = 8192;
  const findTemplate = (
    ctx: { modelRegistry: { find: (provider: string, modelId: string) => unknown } },
    provider: string,
    templateIds: readonly string[],
  ) => {
    for (const templateId of templateIds) {
      const template = ctx.modelRegistry.find(provider, templateId) as Record<
        string,
        unknown
      > | null;
      if (template) {
        return template;
      }
    }
    return undefined;
  };
  const cloneTemplate = (
    template: Record<string, unknown> | undefined,
    modelId: string,
    patch: Record<string, unknown>,
    fallback: Record<string, unknown>,
  ) =>
    ({
      ...(template ?? fallback),
      id: modelId,
      name: modelId,
      ...patch,
    }) as Record<string, unknown>;
  const buildOpenRouterModel = (modelId: string) => {
    const capabilities = mockGetOpenRouterModelCapabilities(modelId);
    return {
      id: modelId,
      name: capabilities?.name ?? modelId,
      api: "openai-completions" as const,
      provider: "openrouter",
      baseUrl: OPENROUTER_BASE_URL,
      reasoning: capabilities?.reasoning ?? false,
      input: capabilities?.input ?? (["text"] as const),
      cost: capabilities?.cost ?? OPENROUTER_FALLBACK_COST,
      contextWindow: capabilities?.contextWindow ?? 200_000,
      maxTokens: capabilities?.maxTokens ?? 8192,
    };
  };
  const buildDynamicModel = (params: {
    provider: string;
    modelId: string;
    modelRegistry: { find: (provider: string, modelId: string) => unknown };
  }) => {
    const modelId = params.modelId.trim();
    const lower = modelId.toLowerCase();
    switch (params.provider) {
      case "openrouter":
        return buildOpenRouterModel(modelId);
      case "github-copilot": {
        const existing = params.modelRegistry.find("github-copilot", lower);
        if (existing) {
          return undefined;
        }
        const template = findTemplate(params, "github-copilot", ["gpt-5.2-codex"]);
        if (lower === "gpt-5.4" && template) {
          return cloneTemplate(
            template,
            modelId,
            {},
            {
              provider: "github-copilot",
              api: "openai-responses",
              reasoning: false,
              input: ["text", "image"],
              cost: OPENROUTER_FALLBACK_COST,
              contextWindow: 128_000,
              maxTokens: DEFAULT_MAX_TOKENS,
            },
          );
        }
        return {
          id: modelId,
          name: modelId,
          provider: "github-copilot",
          api: "openai-responses",
          reasoning: /^o[13](\\b|$)/.test(lower),
          input: ["text", "image"],
          cost: OPENROUTER_FALLBACK_COST,
          contextWindow: 128_000,
          maxTokens: DEFAULT_MAX_TOKENS,
        };
      }
      case "openai-codex": {
        const template =
          lower === "gpt-5.4"
            ? findTemplate(params, "openai-codex", ["gpt-5.4", "gpt-5.2-codex"])
            : lower === "gpt-5.3-codex-spark"
              ? findTemplate(params, "openai-codex", ["gpt-5.4", "gpt-5.2-codex"])
              : findTemplate(params, "openai-codex", ["gpt-5.2-codex"]);
        const fallback = {
          provider: "openai-codex",
          api: "openai-codex-responses",
          baseUrl: OPENAI_CODEX_BASE_URL,
          reasoning: true,
          input: ["text", "image"],
          cost: OPENROUTER_FALLBACK_COST,
          contextWindow: DEFAULT_CONTEXT_WINDOW,
          maxTokens: DEFAULT_CONTEXT_WINDOW,
        };
        if (lower === "gpt-5.4") {
          return cloneTemplate(
            template,
            modelId,
            {
              contextWindow: 1_050_000,
              maxTokens: 128_000,
              provider: "openai-codex",
              api: "openai-codex-responses",
              baseUrl: OPENAI_CODEX_BASE_URL,
            },
            fallback,
          );
        }
        if (lower === "gpt-5.3-codex-spark") {
          return cloneTemplate(
            template,
            modelId,
            {
              provider: "openai-codex",
              api: "openai-codex-responses",
              baseUrl: OPENAI_CODEX_BASE_URL,
              reasoning: true,
              input: ["text"],
              cost: OPENROUTER_FALLBACK_COST,
              contextWindow: 128_000,
              maxTokens: 128_000,
            },
            fallback,
          );
        }
        if (lower === "gpt-5.4") {
          return cloneTemplate(
            template,
            modelId,
            {
              provider: "openai-codex",
              api: "openai-codex-responses",
              baseUrl: OPENAI_CODEX_BASE_URL,
            },
            fallback,
          );
        }
        return undefined;
      }
      case "openai": {
        const templateIds =
          lower === "gpt-5.4"
            ? ["gpt-5.2"]
            : lower === "gpt-5.4-pro"
              ? ["gpt-5.2-pro", "gpt-5.2"]
              : lower === "gpt-5.4-mini"
                ? ["gpt-5-mini"]
                : lower === "gpt-5.4-nano"
                  ? ["gpt-5-nano", "gpt-5-mini"]
                  : undefined;
        if (!templateIds) {
          return undefined;
        }
        const template = findTemplate(params, "openai", templateIds);
        const patch =
          lower === "gpt-5.4" || lower === "gpt-5.4-pro"
            ? {
                provider: "openai",
                api: "openai-responses",
                baseUrl: OPENAI_BASE_URL,
                reasoning: true,
                input: ["text", "image"],
                contextWindow: 1_050_000,
                maxTokens: 128_000,
              }
            : {
                provider: "openai",
                api: "openai-responses",
                baseUrl: OPENAI_BASE_URL,
                reasoning: true,
                input: ["text", "image"],
              };
        return cloneTemplate(template, modelId, patch, {
          provider: "openai",
          api: "openai-responses",
          baseUrl: OPENAI_BASE_URL,
          reasoning: true,
          input: ["text", "image"],
          cost: OPENROUTER_FALLBACK_COST,
          contextWindow: patch.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
          maxTokens: patch.maxTokens ?? DEFAULT_CONTEXT_WINDOW,
        });
      }
      case "anthropic": {
        if (lower !== "claude-opus-4-6" && lower !== "claude-sonnet-4-6") {
          return undefined;
        }
        const template = findTemplate(
          params,
          "anthropic",
          lower === "claude-opus-4-6" ? ["claude-opus-4-5"] : ["claude-sonnet-4-5"],
        );
        return cloneTemplate(
          template,
          modelId,
          {
            provider: "anthropic",
            api: "anthropic-messages",
            baseUrl: ANTHROPIC_BASE_URL,
            reasoning: true,
          },
          {
            provider: "anthropic",
            api: "anthropic-messages",
            baseUrl: ANTHROPIC_BASE_URL,
            reasoning: true,
            input: ["text", "image"],
            cost: OPENROUTER_FALLBACK_COST,
            contextWindow: DEFAULT_CONTEXT_WINDOW,
            maxTokens: DEFAULT_CONTEXT_WINDOW,
          },
        );
      }
      case "zai": {
        if (lower !== "glm-5") {
          return undefined;
        }
        const template = findTemplate(params, "zai", ["glm-4.7"]);
        return cloneTemplate(
          template,
          modelId,
          {
            provider: "zai",
            api: "openai-completions",
            baseUrl: ZAI_BASE_URL,
            reasoning: true,
          },
          {
            provider: "zai",
            api: "openai-completions",
            baseUrl: ZAI_BASE_URL,
            reasoning: true,
            input: ["text"],
            cost: OPENROUTER_FALLBACK_COST,
            contextWindow: DEFAULT_CONTEXT_WINDOW,
            maxTokens: DEFAULT_CONTEXT_WINDOW,
          },
        );
      }
      default:
        return undefined;
    }
  };
  const normalizeDynamicModel = (params: { provider: string; model: Record<string, unknown> }) => {
    if (params.provider === "openai") {
      const baseUrl = typeof params.model.baseUrl === "string" ? params.model.baseUrl : undefined;
      if (params.model.api === "openai-completions" && (!baseUrl || baseUrl === OPENAI_BASE_URL)) {
        return { ...params.model, api: "openai-responses" };
      }
    }
    if (params.provider === "openai-codex") {
      const baseUrl = typeof params.model.baseUrl === "string" ? params.model.baseUrl : undefined;
      const nextApi =
        params.model.api === "openai-responses" &&
        (!baseUrl || baseUrl === OPENAI_BASE_URL || baseUrl === OPENAI_CODEX_BASE_URL)
          ? "openai-codex-responses"
          : params.model.api;
      const nextBaseUrl =
        nextApi === "openai-codex-responses" && (!baseUrl || baseUrl === OPENAI_BASE_URL)
          ? OPENAI_CODEX_BASE_URL
          : baseUrl;
      if (nextApi !== params.model.api || nextBaseUrl !== baseUrl) {
        return { ...params.model, api: nextApi, baseUrl: nextBaseUrl };
      }
    }
    return undefined;
  };
  return {
    clearProviderRuntimeHookCache: () => {},
    resolveProviderBuiltInModelSuppression: (params: {
      context: {
        provider: string;
        modelId: string;
      };
    }) => {
      if (
        (params.context.provider === "openai" ||
          params.context.provider === "azure-openai-responses") &&
        params.context.modelId === "gpt-5.3-codex-spark"
      ) {
        return {
          suppress: true,
          errorMessage: `Unknown model: ${params.context.provider}/gpt-5.3-codex-spark. gpt-5.3-codex-spark is only supported via openai-codex OAuth. Use openai-codex/gpt-5.3-codex-spark.`,
        };
      }
      return undefined;
    },
    resolveProviderRuntimePlugin: (params: { provider: string }) =>
      HANDLED_DYNAMIC_PROVIDERS.has(params.provider)
        ? {
            id: params.provider,
            prepareDynamicModel:
              params.provider === "openrouter"
                ? async (ctx: { modelId: string }) => {
                    await mockLoadOpenRouterModelCapabilities(ctx.modelId);
                  }
                : undefined,
            resolveDynamicModel: (ctx: {
              provider: string;
              modelId: string;
              modelRegistry: { find: (provider: string, modelId: string) => unknown };
            }) => buildDynamicModel(ctx),
            normalizeResolvedModel: (ctx: { provider: string; model: Record<string, unknown> }) =>
              normalizeDynamicModel(ctx),
          }
        : undefined,
    runProviderDynamicModel: (params: {
      provider: string;
      context: {
        modelId: string;
        modelRegistry: { find: (provider: string, modelId: string) => unknown };
      };
    }) =>
      buildDynamicModel({
        provider: params.provider,
        modelId: params.context.modelId,
        modelRegistry: params.context.modelRegistry,
      }),
    prepareProviderDynamicModel: async (params: {
      provider: string;
      context: { modelId: string };
    }) =>
      params.provider === "openrouter"
        ? await mockLoadOpenRouterModelCapabilities(params.context.modelId)
        : undefined,
    normalizeProviderResolvedModelWithPlugin: (params: {
      provider: string;
      context: { model: unknown };
    }) =>
      HANDLED_DYNAMIC_PROVIDERS.has(params.provider)
        ? normalizeDynamicModel({
            provider: params.provider,
            model: params.context.model as Record<string, unknown>,
          })
        : undefined,
  };
});

import type { OpenClawConfig } from "../../config/config.js";
import { clearProviderRuntimeHookCache } from "../../plugins/provider-runtime.js";
import { buildInlineProviderModels, resolveModel, resolveModelAsync } from "./model.js";
import {
  buildOpenAICodexForwardCompatExpectation,
  makeModel,
  mockDiscoveredModel,
  mockOpenAICodexTemplateModel,
  resetMockDiscoverModels,
} from "./model.test-harness.js";

beforeEach(() => {
  clearProviderRuntimeHookCache();
  resetMockDiscoverModels();
  mockGetOpenRouterModelCapabilities.mockReset();
  mockGetOpenRouterModelCapabilities.mockReturnValue(undefined);
  mockLoadOpenRouterModelCapabilities.mockReset();
  mockLoadOpenRouterModelCapabilities.mockResolvedValue();
});

function buildForwardCompatTemplate(params: {
  id: string;
  name: string;
  provider: string;
  api: "anthropic-messages" | "google-gemini-cli" | "openai-completions" | "openai-responses";
  baseUrl: string;
  reasoning?: boolean;
  input?: readonly ["text"] | readonly ["text", "image"];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
}) {
  return {
    id: params.id,
    name: params.name,
    provider: params.provider,
    api: params.api,
    baseUrl: params.baseUrl,
    reasoning: params.reasoning ?? true,
    input: params.input ?? (["text", "image"] as const),
    cost: params.cost ?? { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: params.contextWindow ?? 200000,
    maxTokens: params.maxTokens ?? 64000,
  };
}

describe("buildInlineProviderModels", () => {
  it("attaches provider ids to inline models", () => {
    const providers: Parameters<typeof buildInlineProviderModels>[0] = {
      " alpha ": { baseUrl: "http://alpha.local", models: [makeModel("alpha-model")] },
      beta: { baseUrl: "http://beta.local", models: [makeModel("beta-model")] },
    };

    const result = buildInlineProviderModels(providers);

    expect(result).toEqual([
      {
        ...makeModel("alpha-model"),
        provider: "alpha",
        baseUrl: "http://alpha.local",
        api: undefined,
      },
      {
        ...makeModel("beta-model"),
        provider: "beta",
        baseUrl: "http://beta.local",
        api: undefined,
      },
    ]);
  });

  it("inherits baseUrl from provider when model does not specify it", () => {
    const providers: Parameters<typeof buildInlineProviderModels>[0] = {
      custom: {
        baseUrl: "http://localhost:8000",
        models: [makeModel("custom-model")],
      },
    };

    const result = buildInlineProviderModels(providers);

    expect(result).toHaveLength(1);
    expect(result[0].baseUrl).toBe("http://localhost:8000");
  });

  it("inherits api from provider when model does not specify it", () => {
    const providers: Parameters<typeof buildInlineProviderModels>[0] = {
      custom: {
        baseUrl: "http://localhost:8000",
        api: "anthropic-messages",
        models: [makeModel("custom-model")],
      },
    };

    const result = buildInlineProviderModels(providers);

    expect(result).toHaveLength(1);
    expect(result[0].api).toBe("anthropic-messages");
  });

  it("model-level api takes precedence over provider-level api", () => {
    const providers: Parameters<typeof buildInlineProviderModels>[0] = {
      custom: {
        baseUrl: "http://localhost:8000",
        api: "openai-responses",
        models: [{ ...makeModel("custom-model"), api: "anthropic-messages" as const }],
      },
    };

    const result = buildInlineProviderModels(providers);

    expect(result).toHaveLength(1);
    expect(result[0].api).toBe("anthropic-messages");
  });

  it("inherits both baseUrl and api from provider config", () => {
    const providers: Parameters<typeof buildInlineProviderModels>[0] = {
      custom: {
        baseUrl: "http://localhost:10000",
        api: "anthropic-messages",
        models: [makeModel("claude-opus-4.5")],
      },
    };

    const result = buildInlineProviderModels(providers);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      provider: "custom",
      baseUrl: "http://localhost:10000",
      api: "anthropic-messages",
      name: "claude-opus-4.5",
    });
  });

  it("merges provider-level headers into inline models", () => {
    const providers: Parameters<typeof buildInlineProviderModels>[0] = {
      proxy: {
        baseUrl: "https://proxy.example.com",
        api: "anthropic-messages",
        headers: { "User-Agent": "custom-agent/1.0" },
        models: [makeModel("claude-sonnet-4-6")],
      },
    };

    const result = buildInlineProviderModels(providers);

    expect(result).toHaveLength(1);
    expect(result[0].headers).toEqual({ "User-Agent": "custom-agent/1.0" });
  });

  it("omits headers when neither provider nor model specifies them", () => {
    const providers: Parameters<typeof buildInlineProviderModels>[0] = {
      plain: {
        baseUrl: "http://localhost:8000",
        models: [makeModel("some-model")],
      },
    };

    const result = buildInlineProviderModels(providers);

    expect(result).toHaveLength(1);
    expect(result[0].headers).toBeUndefined();
  });

  it("drops SecretRef marker headers in inline provider models", () => {
    const providers: Parameters<typeof buildInlineProviderModels>[0] = {
      custom: {
        headers: {
          Authorization: "secretref-env:OPENAI_HEADER_TOKEN",
          "X-Managed": "secretref-managed",
          "X-Static": "tenant-a",
        },
        models: [makeModel("custom-model")],
      },
    };

    const result = buildInlineProviderModels(providers);

    expect(result).toHaveLength(1);
    expect(result[0].headers).toEqual({
      "X-Static": "tenant-a",
    });
  });
});

describe("resolveModel", () => {
  it("defaults model input to text when discovery omits input", () => {
    mockDiscoveredModel({
      provider: "custom",
      modelId: "missing-input",
      templateModel: {
        id: "missing-input",
        name: "missing-input",
        api: "openai-completions",
        provider: "custom",
        baseUrl: "http://localhost:9999",
        reasoning: false,
        // NOTE: deliberately omit input to simulate buggy/custom catalogs.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
      },
    });

    const result = resolveModel("custom", "missing-input", "/tmp/agent", {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9999",
            api: "openai-completions",
            // Intentionally keep this minimal — the discovered model provides the rest.
            models: [{ id: "missing-input", name: "missing-input" }],
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.model?.input)).toBe(true);
    expect(result.model?.input).toEqual(["text"]);
  });

  it("includes provider baseUrl in fallback model", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    const result = resolveModel("custom", "missing-model", "/tmp/agent", cfg);

    expect(result.model?.baseUrl).toBe("http://localhost:9000");
    expect(result.model?.provider).toBe("custom");
    expect(result.model?.id).toBe("missing-model");
  });

  it("includes provider headers in provider fallback model", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            headers: { "X-Custom-Auth": "token-123" },
            models: [makeModel("listed-model")],
          },
        },
      },
    } as OpenClawConfig;

    // Requesting a non-listed model forces the providerCfg fallback branch.
    const result = resolveModel("custom", "missing-model", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect((result.model as unknown as { headers?: Record<string, string> }).headers).toEqual({
      "X-Custom-Auth": "token-123",
    });
  });

  it("drops SecretRef marker provider headers in fallback models", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            headers: {
              Authorization: "secretref-env:OPENAI_HEADER_TOKEN",
              "X-Managed": "secretref-managed",
              "X-Custom-Auth": "token-123",
            },
            models: [makeModel("listed-model")],
          },
        },
      },
    } as OpenClawConfig;

    const result = resolveModel("custom", "missing-model", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect((result.model as unknown as { headers?: Record<string, string> }).headers).toEqual({
      "X-Custom-Auth": "token-123",
    });
  });

  it("drops marker headers from discovered models.json entries", () => {
    mockDiscoveredModel({
      provider: "custom",
      modelId: "listed-model",
      templateModel: {
        ...makeModel("listed-model"),
        provider: "custom",
        headers: {
          Authorization: "secretref-env:OPENAI_HEADER_TOKEN",
          "X-Managed": "secretref-managed",
          "X-Static": "tenant-a",
        },
      },
    });

    const result = resolveModel("custom", "listed-model", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect((result.model as unknown as { headers?: Record<string, string> }).headers).toEqual({
      "X-Static": "tenant-a",
    });
  });

  it("prefers matching configured model metadata for fallback token limits", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            models: [
              {
                ...makeModel("model-a"),
                contextWindow: 4096,
                maxTokens: 1024,
              },
              {
                ...makeModel("model-b"),
                contextWindow: 262144,
                maxTokens: 32768,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    const result = resolveModel("custom", "model-b", "/tmp/agent", cfg);

    expect(result.model?.contextWindow).toBe(262144);
    expect(result.model?.maxTokens).toBe(32768);
  });

  it("propagates reasoning from matching configured fallback model", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            models: [
              {
                ...makeModel("model-a"),
                reasoning: false,
              },
              {
                ...makeModel("model-b"),
                reasoning: true,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    const result = resolveModel("custom", "model-b", "/tmp/agent", cfg);

    expect(result.model?.reasoning).toBe(true);
  });

  it("matches prefixed OpenRouter native ids in configured fallback models", () => {
    const cfg = {
      models: {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-completions",
            models: [
              {
                ...makeModel("openrouter/healer-alpha"),
                reasoning: true,
                input: ["text", "image"],
                contextWindow: 262144,
                maxTokens: 65536,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    const models = buildInlineProviderModels(cfg.models?.providers ?? {});
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "openrouter",
          id: "openrouter/healer-alpha",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 262144,
          maxTokens: 65536,
        }),
      ]),
    );
    expect(models.find((model) => model.id === "openrouter/healer-alpha")).toMatchObject({
      provider: "openrouter",
      id: "openrouter/healer-alpha",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 65536,
    });
  });

  it("uses OpenRouter API capabilities for unknown models when cache is populated", () => {
    mockGetOpenRouterModelCapabilities.mockReturnValue({
      name: "Healer Alpha",
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 262144,
      maxTokens: 65536,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });

    const result = resolveModel("openrouter", "openrouter/healer-alpha", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openrouter",
      id: "openrouter/healer-alpha",
      name: "Healer Alpha",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 65536,
    });
  });

  it("falls back to text-only when OpenRouter API cache is empty", () => {
    mockGetOpenRouterModelCapabilities.mockReturnValue(undefined);

    const result = resolveModel("openrouter", "openrouter/healer-alpha", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openrouter",
      id: "openrouter/healer-alpha",
      reasoning: false,
      input: ["text"],
    });
  });

  it("preloads OpenRouter capabilities before first async resolve of an unknown model", async () => {
    mockLoadOpenRouterModelCapabilities.mockImplementation(async (modelId) => {
      if (modelId === "google/gemini-3.1-flash-image-preview") {
        mockGetOpenRouterModelCapabilities.mockReturnValue({
          name: "Google: Nano Banana 2 (Gemini 3.1 Flash Image Preview)",
          input: ["text", "image"],
          reasoning: true,
          contextWindow: 65536,
          maxTokens: 65536,
          cost: { input: 0.5, output: 3, cacheRead: 0, cacheWrite: 0 },
        });
      }
    });

    const result = await resolveModelAsync(
      "openrouter",
      "google/gemini-3.1-flash-image-preview",
      "/tmp/agent",
    );

    expect(mockLoadOpenRouterModelCapabilities).toHaveBeenCalledWith(
      "google/gemini-3.1-flash-image-preview",
    );
    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openrouter",
      id: "google/gemini-3.1-flash-image-preview",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 65536,
      maxTokens: 65536,
    });
  });

  it("skips OpenRouter preload for models already present in the registry", async () => {
    mockDiscoveredModel({
      provider: "openrouter",
      modelId: "openrouter/healer-alpha",
      templateModel: {
        id: "openrouter/healer-alpha",
        name: "Healer Alpha",
        api: "openai-completions",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 65536,
      },
    });

    const result = await resolveModelAsync("openrouter", "openrouter/healer-alpha", "/tmp/agent");

    expect(mockLoadOpenRouterModelCapabilities).not.toHaveBeenCalled();
    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openrouter",
      id: "openrouter/healer-alpha",
      input: ["text", "image"],
    });
  });

  it("prefers configured provider api metadata over discovered registry model", () => {
    mockDiscoveredModel({
      provider: "onehub",
      modelId: "glm-5",
      templateModel: {
        id: "glm-5",
        name: "GLM-5 (cached)",
        provider: "onehub",
        api: "anthropic-messages",
        baseUrl: "https://old-provider.example.com/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 2048,
      },
    });

    const cfg = {
      models: {
        providers: {
          onehub: {
            baseUrl: "http://new-provider.example.com/v1",
            api: "openai-completions",
            models: [
              {
                ...makeModel("glm-5"),
                api: "openai-completions",
                reasoning: true,
                contextWindow: 198000,
                maxTokens: 16000,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    const result = resolveModel("onehub", "glm-5", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "onehub",
      id: "glm-5",
      api: "openai-completions",
      baseUrl: "http://new-provider.example.com/v1",
      reasoning: true,
      contextWindow: 198000,
      maxTokens: 16000,
    });
  });

  it("prefers exact provider config over normalized alias match when both keys exist", () => {
    mockDiscoveredModel({
      provider: "qwen",
      modelId: "qwen3-coder-plus",
      templateModel: {
        id: "qwen3-coder-plus",
        name: "Qwen3 Coder Plus",
        provider: "qwen",
        api: "openai-completions",
        baseUrl: "https://default-provider.example.com/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 2048,
      },
    });

    const cfg = {
      models: {
        providers: {
          "qwen-portal": {
            baseUrl: "https://canonical-provider.example.com/v1",
            api: "openai-completions",
            headers: { "X-Provider": "canonical" },
            models: [{ ...makeModel("qwen3-coder-plus"), reasoning: false }],
          },
          qwen: {
            baseUrl: "https://alias-provider.example.com/v1",
            api: "anthropic-messages",
            headers: { "X-Provider": "alias" },
            models: [
              {
                ...makeModel("qwen3-coder-plus"),
                api: "anthropic-messages",
                reasoning: true,
                contextWindow: 262144,
                maxTokens: 32768,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    const result = resolveModel("qwen", "qwen3-coder-plus", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "qwen",
      id: "qwen3-coder-plus",
      api: "anthropic-messages",
      baseUrl: "https://alias-provider.example.com",
      reasoning: true,
      contextWindow: 262144,
      maxTokens: 32768,
      headers: { "X-Provider": "alias" },
    });
  });

  it("builds an openai-codex fallback for gpt-5.4", () => {
    mockOpenAICodexTemplateModel();

    const result = resolveModel("openai-codex", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject(buildOpenAICodexForwardCompatExpectation("gpt-5.4"));
  });

  it("builds an openai-codex fallback for gpt-5.4", () => {
    mockOpenAICodexTemplateModel();

    const result = resolveModel("openai-codex", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject(buildOpenAICodexForwardCompatExpectation("gpt-5.4"));
  });

  it("builds an openai-codex fallback for gpt-5.3-codex-spark", () => {
    mockOpenAICodexTemplateModel();

    const result = resolveModel("openai-codex", "gpt-5.3-codex-spark", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject(
      buildOpenAICodexForwardCompatExpectation("gpt-5.3-codex-spark"),
    );
  });

  it("keeps openai-codex gpt-5.3-codex-spark when discovery provides it", () => {
    mockDiscoveredModel({
      provider: "openai-codex",
      modelId: "gpt-5.3-codex-spark",
      templateModel: {
        ...buildOpenAICodexForwardCompatExpectation("gpt-5.3-codex-spark"),
        name: "GPT-5.3 Codex Spark",
        input: ["text"],
      },
    });

    const result = resolveModel("openai-codex", "gpt-5.3-codex-spark", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.3-codex-spark",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    });
  });

  it("rejects stale direct openai gpt-5.3-codex-spark discovery rows", () => {
    mockDiscoveredModel({
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      templateModel: buildForwardCompatTemplate({
        id: "gpt-5.3-codex-spark",
        name: "GPT-5.3 Codex Spark",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      }),
    });

    const result = resolveModel("openai", "gpt-5.3-codex-spark", "/tmp/agent");

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is only supported via openai-codex OAuth. Use openai-codex/gpt-5.3-codex-spark.",
    );
  });

  it("applies provider overrides to openai gpt-5.4 forward-compat models", () => {
    mockDiscoveredModel({
      provider: "openai",
      modelId: "gpt-5.2",
      templateModel: buildForwardCompatTemplate({
        id: "gpt-5.2",
        name: "GPT-5.2",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      }),
    });

    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://proxy.example.com/v1",
            headers: { "X-Proxy-Auth": "token-123" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModel("openai", "gpt-5.4", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://proxy.example.com/v1",
    });
    expect((result.model as unknown as { headers?: Record<string, string> }).headers).toMatchObject(
      {
        "X-Proxy-Auth": "token-123",
      },
    );
  });

  it("applies configured overrides to github-copilot dynamic models", () => {
    const cfg = {
      models: {
        providers: {
          "github-copilot": {
            baseUrl: "https://proxy.example.com/v1",
            api: "openai-completions",
            headers: { "X-Proxy-Auth": "token-123" },
            models: [
              {
                ...makeModel("gpt-5.4-mini"),
                reasoning: true,
                input: ["text"],
                contextWindow: 256000,
                maxTokens: 32000,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    const result = resolveModel("github-copilot", "gpt-5.4-mini", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "github-copilot",
      id: "gpt-5.4-mini",
      api: "openai-completions",
      baseUrl: "https://proxy.example.com/v1",
      reasoning: true,
      input: ["text"],
      contextWindow: 256000,
      maxTokens: 32000,
    });
    expect((result.model as unknown as { headers?: Record<string, string> }).headers).toMatchObject(
      {
        "X-Proxy-Auth": "token-123",
      },
    );
  });

  it("builds an openai fallback for gpt-5.4 mini from the gpt-5-mini template", () => {
    mockDiscoveredModel({
      provider: "openai",
      modelId: "gpt-5-mini",
      templateModel: buildForwardCompatTemplate({
        id: "gpt-5-mini",
        name: "GPT-5 mini",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 400_000,
        maxTokens: 128_000,
      }),
    });

    const result = resolveModel("openai", "gpt-5.4-mini", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai",
      id: "gpt-5.4-mini",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
  });

  it("builds an openai fallback for gpt-5.4 nano from the gpt-5-nano template", () => {
    mockDiscoveredModel({
      provider: "openai",
      modelId: "gpt-5-nano",
      templateModel: buildForwardCompatTemplate({
        id: "gpt-5-nano",
        name: "GPT-5 nano",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 400_000,
        maxTokens: 128_000,
      }),
    });

    const result = resolveModel("openai", "gpt-5.4-nano", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai",
      id: "gpt-5.4-nano",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
  });

  it("normalizes stale native openai gpt-5.4 completions transport to responses", () => {
    mockDiscoveredModel({
      provider: "openai",
      modelId: "gpt-5.4",
      templateModel: buildForwardCompatTemplate({
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai",
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
      }),
    });

    const result = resolveModel("openai", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("keeps proxied openai completions transport untouched", () => {
    mockDiscoveredModel({
      provider: "openai",
      modelId: "gpt-5.4",
      templateModel: buildForwardCompatTemplate({
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai",
        api: "openai-completions",
        baseUrl: "https://proxy.example.com/v1",
      }),
    });

    const result = resolveModel("openai", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-completions",
      baseUrl: "https://proxy.example.com/v1",
    });
  });
});

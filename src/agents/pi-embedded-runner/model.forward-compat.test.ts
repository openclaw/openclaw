import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pi-model-discovery.js", () => ({
  discoverAuthStorage: vi.fn(() => ({ mocked: true })),
  discoverModels: vi.fn(() => ({ find: vi.fn(() => null) })),
}));

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const ZAI_BASE_URL = "https://api.z.ai/api/paas/v4";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const OPENROUTER_FALLBACK_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

vi.mock("../../plugins/provider-runtime.js", () => {
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
  const buildDynamicModel = (params: {
    provider: string;
    modelId: string;
    modelRegistry: { find: (provider: string, modelId: string) => unknown };
  }) => {
    const modelId = params.modelId.trim();
    const lower = modelId.toLowerCase();
    switch (params.provider) {
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
      default:
        return undefined;
    }
  };
  const normalizeDynamicModel = (params: { provider: string; model: Record<string, unknown> }) => {
    if (params.provider !== "openai-codex") {
      return undefined;
    }
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
      params.provider === "anthropic" ||
      params.provider === "zai" ||
      params.provider === "openai-codex"
        ? {
            id: params.provider,
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
    prepareProviderDynamicModel: async () => undefined,
    normalizeProviderResolvedModelWithPlugin: (params: {
      provider: string;
      context: { model: unknown };
    }) =>
      normalizeDynamicModel({
        provider: params.provider,
        model: params.context.model as Record<string, unknown>,
      }),
  };
});

import type { OpenClawConfig } from "../../config/config.js";
import { clearProviderRuntimeHookCache } from "../../plugins/provider-runtime.js";
import { discoverModels } from "../pi-model-discovery.js";
import { resolveModel, resolveModelWithRegistry } from "./model.js";

const OPENAI_CODEX_TEMPLATE_MODEL = {
  id: "gpt-5.2-codex",
  name: "GPT-5.2 Codex",
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text", "image"] as const,
  cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  contextWindow: 272000,
  maxTokens: 128000,
};

function makeModel(id: string) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  };
}

beforeEach(() => {
  clearProviderRuntimeHookCache();
});

function buildForwardCompatTemplate(params: {
  id: string;
  name: string;
  provider: string;
  api: "anthropic-messages" | "openai-completions" | "openai-responses";
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

function expectResolvedForwardCompatFallback(params: {
  provider: string;
  id: string;
  expectedModel: Record<string, unknown>;
  cfg?: OpenClawConfig;
}) {
  const result = resolveModel(params.provider, params.id, "/tmp/agent", params.cfg);
  expect(result.error).toBeUndefined();
  expect(result.model).toMatchObject(params.expectedModel);
}

function mockOpenAICodexTemplateModel() {
  return {
    provider: "openai-codex",
    modelId: "gpt-5.2-codex",
    model: OPENAI_CODEX_TEMPLATE_MODEL,
  };
}

function mockDiscoveredModel(params: {
  provider: string;
  modelId: string;
  templateModel: unknown;
}) {
  vi.mocked(discoverModels).mockReturnValue({
    find: vi.fn((provider: string, modelId: string) => {
      if (provider === params.provider && modelId === params.modelId) {
        return params.templateModel;
      }
      return null;
    }),
  } as unknown as ReturnType<typeof discoverModels>);
}

function expectResolvedForwardCompatFallbackWithRegistry(params: {
  provider: string;
  id: string;
  expectedModel: Record<string, unknown>;
  cfg?: OpenClawConfig;
  registryEntries: Array<{
    provider: string;
    modelId: string;
    model: unknown;
  }>;
}) {
  const result = resolveModelWithRegistry({
    provider: params.provider,
    modelId: params.id,
    cfg: params.cfg,
    agentDir: "/tmp/agent",
    modelRegistry: {
      find(provider: string, modelId: string) {
        const match = params.registryEntries.find(
          (entry) => entry.provider === provider && entry.modelId === modelId,
        );
        return match?.model ?? null;
      },
    } as never,
  });
  expect(result).toMatchObject(params.expectedModel);
}

function expectUnknownModelError(provider: string, id: string) {
  const result = resolveModel(provider, id, "/tmp/agent");
  expect(result.model).toBeUndefined();
  expect(result.error).toBe(`Unknown model: ${provider}/${id}`);
}

describe("resolveModel forward-compat tail", () => {
  it("builds an anthropic forward-compat fallback for claude-opus-4-6", () => {
    mockDiscoveredModel({
      provider: "anthropic",
      modelId: "claude-opus-4-5",
      templateModel: buildForwardCompatTemplate({
        id: "claude-opus-4-5",
        name: "Claude Opus 4.5",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      }),
    });

    expectResolvedForwardCompatFallback({
      provider: "anthropic",
      id: "claude-opus-4-6",
      expectedModel: {
        provider: "anthropic",
        id: "claude-opus-4-6",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
      },
    });
  });

  it("builds an anthropic forward-compat fallback for claude-sonnet-4-6", () => {
    mockDiscoveredModel({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      templateModel: buildForwardCompatTemplate({
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      }),
    });

    expectResolvedForwardCompatFallback({
      provider: "anthropic",
      id: "claude-sonnet-4-6",
      expectedModel: {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
      },
    });
  });

  it("builds a zai forward-compat fallback for glm-5", () => {
    expectResolvedForwardCompatFallbackWithRegistry({
      provider: "zai",
      id: "glm-5",
      expectedModel: {
        provider: "zai",
        id: "glm-5",
        api: "openai-completions",
        baseUrl: "https://api.z.ai/api/paas/v4",
        reasoning: true,
      },
      registryEntries: [
        {
          provider: "zai",
          modelId: "glm-4.7",
          model: buildForwardCompatTemplate({
            id: "glm-4.7",
            name: "GLM-4.7",
            provider: "zai",
            api: "openai-completions",
            baseUrl: "https://api.z.ai/api/paas/v4",
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            maxTokens: 131072,
          }),
        },
      ],
    });
  });

  it("keeps unknown-model errors when no antigravity thinking template exists", () => {
    expectUnknownModelError("google-antigravity", "claude-opus-4-6-thinking");
  });

  it("keeps unknown-model errors when no antigravity non-thinking template exists", () => {
    expectUnknownModelError("google-antigravity", "claude-opus-4-6");
  });

  it("keeps unknown-model errors for non-gpt-5 openai-codex ids", () => {
    expectUnknownModelError("openai-codex", "gpt-4.1-mini");
  });

  it("rejects direct openai gpt-5.3-codex-spark with a codex-only hint", () => {
    const result = resolveModel("openai", "gpt-5.3-codex-spark", "/tmp/agent");

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is only supported via openai-codex OAuth. Use openai-codex/gpt-5.3-codex-spark.",
    );
  });

  it("keeps suppressed openai gpt-5.3-codex-spark from falling through provider fallback", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
            models: [{ ...makeModel("gpt-4.1"), api: "openai-responses" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModel("openai", "gpt-5.3-codex-spark", "/tmp/agent", cfg);

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is only supported via openai-codex OAuth. Use openai-codex/gpt-5.3-codex-spark.",
    );
  });

  it("rejects azure openai gpt-5.3-codex-spark with a codex-only hint", () => {
    const result = resolveModel("azure-openai-responses", "gpt-5.3-codex-spark", "/tmp/agent");

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: azure-openai-responses/gpt-5.3-codex-spark. gpt-5.3-codex-spark is only supported via openai-codex OAuth. Use openai-codex/gpt-5.3-codex-spark.",
    );
  });

  it("uses codex fallback even when openai-codex provider is configured", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://custom.example.com",
          },
        },
      },
    } as unknown as OpenClawConfig;

    expectResolvedForwardCompatFallback({
      provider: "openai-codex",
      id: "gpt-5.4",
      cfg,
      expectedModel: {
        api: "openai-codex-responses",
        id: "gpt-5.4",
        provider: "openai-codex",
      },
    });
  });

  it("uses codex fallback when inline model omits api (#39682)", () => {
    mockOpenAICodexTemplateModel();

    const cfg: OpenClawConfig = {
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://custom.example.com",
            headers: { "X-Custom-Auth": "token-123" },
            models: [{ id: "gpt-5.4" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModel("openai-codex", "gpt-5.4", "/tmp/agent", cfg);
    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      api: "openai-codex-responses",
      baseUrl: "https://custom.example.com",
      headers: { "X-Custom-Auth": "token-123" },
      id: "gpt-5.4",
      provider: "openai-codex",
    });
  });

  it("normalizes openai-codex gpt-5.4 overrides away from /v1/responses", () => {
    mockOpenAICodexTemplateModel();

    const cfg: OpenClawConfig = {
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
          },
        },
      },
    } as unknown as OpenClawConfig;

    expectResolvedForwardCompatFallback({
      provider: "openai-codex",
      id: "gpt-5.4",
      cfg,
      expectedModel: {
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        id: "gpt-5.4",
        provider: "openai-codex",
      },
    });
  });

  it("does not rewrite openai baseUrl when openai-codex api stays non-codex", () => {
    mockOpenAICodexTemplateModel();

    const cfg: OpenClawConfig = {
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions",
          },
        },
      },
    } as unknown as OpenClawConfig;

    expectResolvedForwardCompatFallback({
      provider: "openai-codex",
      id: "gpt-5.4",
      cfg,
      expectedModel: {
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.4",
        provider: "openai-codex",
      },
    });
  });

  it("includes auth hint for unknown ollama models (#17328)", () => {
    const result = resolveModel("ollama", "gemma3:4b", "/tmp/agent");

    expect(result.model).toBeUndefined();
    expect(result.error).toContain("Unknown model: ollama/gemma3:4b");
    expect(result.error).toContain("OLLAMA_API_KEY");
    expect(result.error).toContain("docs.openclaw.ai/providers/ollama");
  });

  it("includes auth hint for unknown vllm models", () => {
    const result = resolveModel("vllm", "llama-3-70b", "/tmp/agent");

    expect(result.model).toBeUndefined();
    expect(result.error).toContain("Unknown model: vllm/llama-3-70b");
    expect(result.error).toContain("VLLM_API_KEY");
  });

  it("does not add auth hint for non-local providers", () => {
    const result = resolveModel("google-antigravity", "some-model", "/tmp/agent");

    expect(result.model).toBeUndefined();
    expect(result.error).toBe("Unknown model: google-antigravity/some-model");
  });

  it("applies provider baseUrl override to registry-found models", () => {
    mockDiscoveredModel({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      templateModel: buildForwardCompatTemplate({
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      }),
    });

    const cfg = {
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://my-proxy.example.com",
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModel("anthropic", "claude-sonnet-4-5", "/tmp/agent", cfg);
    expect(result.error).toBeUndefined();
    expect(result.model?.baseUrl).toBe("https://my-proxy.example.com");
  });

  it("applies provider headers override to registry-found models", () => {
    mockDiscoveredModel({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      templateModel: buildForwardCompatTemplate({
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      }),
    });

    const cfg = {
      models: {
        providers: {
          anthropic: {
            headers: { "X-Custom-Auth": "token-123" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModel("anthropic", "claude-sonnet-4-5", "/tmp/agent", cfg);
    expect(result.error).toBeUndefined();
    expect((result.model as unknown as { headers?: Record<string, string> }).headers).toEqual({
      "X-Custom-Auth": "token-123",
    });
  });

  it("lets provider config override registry-found kimi user agent headers", () => {
    mockDiscoveredModel({
      provider: "kimi",
      modelId: "kimi-code",
      templateModel: {
        ...buildForwardCompatTemplate({
          id: "kimi-code",
          name: "Kimi Code",
          provider: "kimi",
          api: "anthropic-messages",
          baseUrl: "https://api.kimi.com/coding/",
        }),
        headers: { "User-Agent": "claude-code/0.1.0" },
      },
    });

    const cfg = {
      models: {
        providers: {
          kimi: {
            headers: {
              "User-Agent": "custom-kimi-client/1.0",
              "X-Kimi-Tenant": "tenant-a",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModel("kimi", "kimi-code", "/tmp/agent", cfg);
    expect(result.error).toBeUndefined();
    expect(result.model?.id).toBe("kimi-for-coding");
    expect((result.model as unknown as { headers?: Record<string, string> }).headers).toEqual({
      "User-Agent": "custom-kimi-client/1.0",
      "X-Kimi-Tenant": "tenant-a",
    });
  });

  it("does not override when no provider config exists", () => {
    mockDiscoveredModel({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      templateModel: buildForwardCompatTemplate({
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      }),
    });

    const result = resolveModel("anthropic", "claude-sonnet-4-5", "/tmp/agent");
    expect(result.error).toBeUndefined();
    expect(result.model?.baseUrl).toBe("https://api.anthropic.com");
  });
});

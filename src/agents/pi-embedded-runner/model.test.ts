import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pi-model-discovery.js", () => ({
  discoverAuthStorage: vi.fn(() => ({ mocked: true })),
  discoverModels: vi.fn(() => ({ find: vi.fn(() => null) })),
}));

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

import type { OpenClawConfig } from "../../config/config.js";
import { buildInlineProviderModels, resolveModel, resolveModelAsync } from "./model.js";
import {
  buildOpenAICodexForwardCompatExpectation,
  makeModel,
  mockDiscoveredModel,
  mockOpenAICodexTemplateModel,
  resetMockDiscoverModels,
} from "./model.test-harness.js";

beforeEach(() => {
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
    reasoning: true,
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

function expectUnknownModelError(provider: string, id: string) {
  const result = resolveModel(provider, id, "/tmp/agent");
  expect(result.model).toBeUndefined();
  expect(result.error).toBe(`Unknown model: ${provider}/${id}`);
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

    const result = resolveModel("openrouter", "openrouter/healer-alpha", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
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

  it("builds an openai-codex fallback for gpt-5.3-codex", () => {
    mockOpenAICodexTemplateModel();

    const result = resolveModel("openai-codex", "gpt-5.3-codex", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject(buildOpenAICodexForwardCompatExpectation("gpt-5.3-codex"));
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
    expect((result.model as unknown as { headers?: Record<string, string> }).headers).toEqual({
      "X-Proxy-Auth": "token-123",
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
    mockDiscoveredModel({
      provider: "zai",
      modelId: "glm-4.7",
      templateModel: buildForwardCompatTemplate({
        id: "glm-4.7",
        name: "GLM-4.7",
        provider: "zai",
        api: "openai-completions",
        baseUrl: "https://api.z.ai/api/paas/v4",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        maxTokens: 131072,
      }),
    });

    expectResolvedForwardCompatFallback({
      provider: "zai",
      id: "glm-5",
      expectedModel: {
        provider: "zai",
        id: "glm-5",
        api: "openai-completions",
        baseUrl: "https://api.z.ai/api/paas/v4",
        reasoning: true,
      },
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
    } as OpenClawConfig;

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
    // This test verifies the ordering: codex fallback must fire BEFORE the generic providerCfg fallback.
    // If ordering is wrong, the generic fallback would use api: "openai-responses" (the default)
    // instead of "openai-codex-responses".
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://custom.example.com",
            // No models array, or models without gpt-5.3-codex
          },
        },
      },
    } as unknown as OpenClawConfig;

    expectResolvedForwardCompatFallback({
      provider: "openai-codex",
      id: "gpt-5.3-codex",
      cfg,
      expectedModel: {
        api: "openai-codex-responses",
        id: "gpt-5.3-codex",
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
    // resetMockDiscoverModels() in beforeEach already sets find → null
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
      provider: "kimi-coding",
      modelId: "k2p5",
      templateModel: {
        ...buildForwardCompatTemplate({
          id: "k2p5",
          name: "Kimi for Coding",
          provider: "kimi-coding",
          api: "anthropic-messages",
          baseUrl: "https://api.kimi.com/coding/",
        }),
        headers: { "User-Agent": "claude-code/0.1.0" },
      },
    });

    const cfg = {
      models: {
        providers: {
          "kimi-coding": {
            headers: {
              "User-Agent": "custom-kimi-client/1.0",
              "X-Kimi-Tenant": "tenant-a",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModel("kimi-coding", "k2p5", "/tmp/agent", cfg);
    expect(result.error).toBeUndefined();
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

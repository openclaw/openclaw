import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pi-model-discovery.js", () => ({
  discoverAuthStorage: vi.fn(() => ({ mocked: true })),
  discoverModels: vi.fn(() => ({ find: vi.fn(() => null) })),
}));

import type { OpenClawConfig } from "../../config/config.js";
import { buildInlineProviderModels, resolveModel } from "./model.js";
import {
  buildOpenAICodexForwardCompatExpectation,
  makeModel,
  mockDiscoveredModel,
  mockOpenAICodexTemplateModel,
  resetMockDiscoverModels,
} from "./model.test-harness.js";

beforeEach(() => {
  resetMockDiscoverModels();
});

function buildForwardCompatTemplate(params: {
  id: string;
  name: string;
  provider: string;
  api: "anthropic-messages" | "google-gemini-cli" | "openai-completions";
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
});

describe("resolveModel", () => {
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

  it("builds an openai-codex fallback for gpt-5.3-codex", () => {
    mockOpenAICodexTemplateModel();

    const result = resolveModel("openai-codex", "gpt-5.3-codex", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject(buildOpenAICodexForwardCompatExpectation("gpt-5.3-codex"));
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
});

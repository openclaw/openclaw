import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pi-model-discovery.js", () => ({
  discoverAuthStorage: vi.fn(() => ({ mocked: true })),
  discoverModels: vi.fn(() => ({ find: vi.fn(() => null) })),
}));

vi.mock("../../plugins/provider-runtime.js", async () => {
  const { createProviderRuntimeTestMock } =
    await import("./model.provider-runtime.test-support.js");
  return createProviderRuntimeTestMock({
    handledDynamicProviders: ["anthropic", "zai", "openai-codex"],
  });
});

import type { OpenClawConfig } from "../../config/config.js";
import { clearProviderRuntimeHookCache } from "../../plugins/provider-runtime.js";
import {
  expectResolvedForwardCompatFallback,
  expectUnknownModelError,
} from "./model.forward-compat.test-support.js";
import { resolveModel } from "./model.js";
import {
  makeModel,
  mockDiscoveredModel,
  mockOpenAICodexTemplateModel,
  resetMockDiscoverModels,
} from "./model.test-harness.js";

beforeEach(() => {
  clearProviderRuntimeHookCache();
  resetMockDiscoverModels();
});

describe("resolveModel forward-compat errors and overrides", () => {
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
      templateModel: {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
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
      templateModel: {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
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
        id: "kimi-code",
        name: "Kimi Code",
        provider: "kimi",
        api: "anthropic-messages",
        baseUrl: "https://api.kimi.com/coding/",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 200000,
        maxTokens: 64000,
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
      templateModel: {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
    });

    const result = resolveModel("anthropic", "claude-sonnet-4-5", "/tmp/agent");
    expect(result.error).toBeUndefined();
    expect(result.model?.baseUrl).toBe("https://api.anthropic.com");
  });
});

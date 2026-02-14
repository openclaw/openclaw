import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pi-model-discovery.js", () => ({
  discoverAuthStorage: vi.fn(() => ({ mocked: true })),
  discoverModels: vi.fn(() => ({ find: vi.fn(() => null) })),
}));

import type { OpenClawConfig } from "../../config/config.js";
import { discoverModels } from "../pi-model-discovery.js";
import { buildInlineProviderModels, resolveModel } from "./model.js";

const makeModel = (id: string) => ({
  id,
  name: id,
  reasoning: false,
  input: ["text"] as const,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1,
  maxTokens: 1,
});

beforeEach(() => {
  vi.mocked(discoverModels).mockReturnValue({
    find: vi.fn(() => null),
  } as unknown as ReturnType<typeof discoverModels>);
});

describe("buildInlineProviderModels", () => {
  it("attaches provider ids to inline models", () => {
    const providers = {
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
    const providers = {
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
    const providers = {
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
    const providers = {
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
    const providers = {
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

  it("builds an openai-codex fallback for gpt-5.3-codex", () => {
    const templateModel = {
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

    vi.mocked(discoverModels).mockReturnValue({
      find: vi.fn((provider: string, modelId: string) => {
        if (provider === "openai-codex" && modelId === "gpt-5.2-codex") {
          return templateModel;
        }
        return null;
      }),
    } as unknown as ReturnType<typeof discoverModels>);

    const result = resolveModel("openai-codex", "gpt-5.3-codex", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.3-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      contextWindow: 272000,
      maxTokens: 128000,
    });
  });

  it("builds an anthropic forward-compat fallback for claude-opus-4-6", () => {
    const templateModel = {
      id: "claude-opus-4-5",
      name: "Claude Opus 4.5",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text", "image"] as const,
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 200000,
      maxTokens: 64000,
    };

    vi.mocked(discoverModels).mockReturnValue({
      find: vi.fn((provider: string, modelId: string) => {
        if (provider === "anthropic" && modelId === "claude-opus-4-5") {
          return templateModel;
        }
        return null;
      }),
    } as unknown as ReturnType<typeof discoverModels>);

    const result = resolveModel("anthropic", "claude-opus-4-6", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "anthropic",
      id: "claude-opus-4-6",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
    });
  });

  it("builds an antigravity forward-compat fallback for claude-opus-4-6-thinking", () => {
    const templateModel = {
      id: "claude-opus-4-5-thinking",
      name: "Claude Opus 4.5 Thinking",
      provider: "google-antigravity",
      api: "google-gemini-cli",
      baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
      reasoning: true,
      input: ["text", "image"] as const,
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 200000,
      maxTokens: 64000,
    };

    vi.mocked(discoverModels).mockReturnValue({
      find: vi.fn((provider: string, modelId: string) => {
        if (provider === "google-antigravity" && modelId === "claude-opus-4-5-thinking") {
          return templateModel;
        }
        return null;
      }),
    } as unknown as ReturnType<typeof discoverModels>);

    const result = resolveModel("google-antigravity", "claude-opus-4-6-thinking", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "google-antigravity",
      id: "claude-opus-4-6-thinking",
      api: "google-gemini-cli",
      baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
      reasoning: true,
      contextWindow: 200000,
      maxTokens: 64000,
    });
  });

  it("builds an antigravity forward-compat fallback for claude-opus-4-6", () => {
    const templateModel = {
      id: "claude-opus-4-5",
      name: "Claude Opus 4.5",
      provider: "google-antigravity",
      api: "google-gemini-cli",
      baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
      reasoning: true,
      input: ["text", "image"] as const,
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 200000,
      maxTokens: 64000,
    };

    vi.mocked(discoverModels).mockReturnValue({
      find: vi.fn((provider: string, modelId: string) => {
        if (provider === "google-antigravity" && modelId === "claude-opus-4-5") {
          return templateModel;
        }
        return null;
      }),
    } as unknown as ReturnType<typeof discoverModels>);

    const result = resolveModel("google-antigravity", "claude-opus-4-6", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "google-antigravity",
      id: "claude-opus-4-6",
      api: "google-gemini-cli",
      baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
      reasoning: true,
      contextWindow: 200000,
      maxTokens: 64000,
    });
  });

  it("builds a zai forward-compat fallback for glm-5", () => {
    const templateModel = {
      id: "glm-4.7",
      name: "GLM-4.7",
      provider: "zai",
      api: "openai-completions",
      baseUrl: "https://api.z.ai/api/paas/v4",
      reasoning: true,
      input: ["text"] as const,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 131072,
    };

    vi.mocked(discoverModels).mockReturnValue({
      find: vi.fn((provider: string, modelId: string) => {
        if (provider === "zai" && modelId === "glm-4.7") {
          return templateModel;
        }
        return null;
      }),
    } as unknown as ReturnType<typeof discoverModels>);

    const result = resolveModel("zai", "glm-5", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "zai",
      id: "glm-5",
      api: "openai-completions",
      baseUrl: "https://api.z.ai/api/paas/v4",
      reasoning: true,
    });
  });

  it("keeps unknown-model errors when no antigravity thinking template exists", () => {
    vi.mocked(discoverModels).mockReturnValue({
      find: vi.fn(() => null),
    } as unknown as ReturnType<typeof discoverModels>);

    const result = resolveModel("google-antigravity", "claude-opus-4-6-thinking", "/tmp/agent");

    expect(result.model).toBeUndefined();
    expect(result.error).toBe("Unknown model: google-antigravity/claude-opus-4-6-thinking");
  });

  it("keeps unknown-model errors when no antigravity non-thinking template exists", () => {
    vi.mocked(discoverModels).mockReturnValue({
      find: vi.fn(() => null),
    } as unknown as ReturnType<typeof discoverModels>);

    const result = resolveModel("google-antigravity", "claude-opus-4-6", "/tmp/agent");

    expect(result.model).toBeUndefined();
    expect(result.error).toBe("Unknown model: google-antigravity/claude-opus-4-6");
  });

  it("keeps unknown-model errors for non-gpt-5 openai-codex ids", () => {
    const result = resolveModel("openai-codex", "gpt-4.1-mini", "/tmp/agent");
    expect(result.model).toBeUndefined();
    expect(result.error).toBe("Unknown model: openai-codex/gpt-4.1-mini");
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
    } as OpenClawConfig;

    vi.mocked(discoverModels).mockReturnValue({
      find: vi.fn(() => null),
    } as unknown as ReturnType<typeof discoverModels>);

    const result = resolveModel("openai-codex", "gpt-5.3-codex", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model?.api).toBe("openai-codex-responses");
    expect(result.model?.id).toBe("gpt-5.3-codex");
    expect(result.model?.provider).toBe("openai-codex");
  });
});

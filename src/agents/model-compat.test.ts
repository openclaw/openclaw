/**
 * Regression coverage for model compatibility and live-model curation.
 * Exercises catalog compatibility, provider modernity hooks, and live sweep selection.
 */
import path from "node:path";
import type { Api, Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerRuntimeMocks = vi.hoisted(() => ({
  resolveProviderModernModelRef: vi.fn(),
}));

vi.mock("../plugins/provider-runtime.js", () => {
  return {
    resolveProviderModernModelRef: providerRuntimeMocks.resolveProviderModernModelRef,
  };
});

import { normalizeModelCompat } from "../plugins/provider-model-compat.js";
import {
  DEFAULT_HIGH_SIGNAL_LIVE_MODEL_LIMIT,
  DEFAULT_SMALL_LIVE_MODEL_LIMIT,
  isHighSignalLiveModelRef,
  isModernModelRef,
  isPrioritizedHighSignalLiveModelRef,
  isSmallLiveModelRef,
  listPrioritizedHighSignalLiveModelRefs,
  resolveHighSignalLiveModelLimit,
  selectHighSignalLiveItems,
  selectSmallLiveItems,
} from "./test-helpers/live-model-dynamic-candidates.js";

const baseModel = (): Model =>
  ({
    id: "glm-4.7",
    name: "GLM-4.7",
    api: "openai-completions",
    provider: "zai",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  }) as Model;

function supportsDeveloperRole(model: Model): boolean | undefined {
  return (model.compat as { supportsDeveloperRole?: boolean } | undefined)?.supportsDeveloperRole;
}

function supportsUsageInStreaming(model: Model): boolean | undefined {
  return (model.compat as { supportsUsageInStreaming?: boolean } | undefined)
    ?.supportsUsageInStreaming;
}

function supportsStrictMode(model: Model): boolean | undefined {
  return (model.compat as { supportsStrictMode?: boolean } | undefined)?.supportsStrictMode;
}

function expectSupportsDeveloperRoleForcedOff(overrides?: Partial<Model>): void {
  const model = { ...baseModel(), ...overrides };
  delete (model as { compat?: unknown }).compat;
  const normalized = normalizeModelCompat(model as Model);
  expect(supportsDeveloperRole(normalized)).toBe(false);
}

function expectSupportsStrictModeForcedOff(overrides?: Partial<Model>): void {
  const model = { ...baseModel(), ...overrides };
  delete (model as { compat?: unknown }).compat;
  const normalized = normalizeModelCompat(model as Model);
  expect(supportsStrictMode(normalized)).toBe(false);
}

function expectNativeStreamingSupported(overrides: Partial<Model>): void {
  const model = { ...baseModel(), ...overrides };
  delete (model as { compat?: unknown }).compat;
  const normalized = normalizeModelCompat(model as Model);
  expect(supportsDeveloperRole(normalized)).toBe(false);
  expect(supportsUsageInStreaming(normalized)).toBe(true);
  expect(supportsStrictMode(normalized)).toBe(false);
}

function expectHighSignal(provider: string, id: string, expected: boolean): void {
  expect(isHighSignalLiveModelRef({ provider, id })).toBe(expected);
}

beforeEach(() => {
  // Endpoint capabilities come from manifests. Keep source tests independent
  // from partial dist output left by an earlier build in the same checkout.
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(process.cwd(), "extensions"));
  providerRuntimeMocks.resolveProviderModernModelRef.mockReset();
  providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("normalizeModelCompat — Anthropic baseUrl", () => {
  const anthropicBase = (): Model =>
    ({
      id: "claude-opus-4-6",
      name: "claude-opus-4-6",
      api: "anthropic-messages",
      provider: "anthropic",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    }) as Model;

  it("strips trailing /v1/ (with slash) from anthropic-messages baseUrl", () => {
    const model = { ...anthropicBase(), baseUrl: "https://api.anthropic.com/v1/" };
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("https://api.anthropic.com");
  });

  it("leaves anthropic-messages baseUrl without /v1 unchanged", () => {
    const model = { ...anthropicBase(), baseUrl: "https://api.anthropic.com" };
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("https://api.anthropic.com");
  });

  it("leaves baseUrl undefined unchanged for anthropic-messages", () => {
    const model = anthropicBase();
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBeUndefined();
  });

  it("does not strip /v1 from non-anthropic-messages models", () => {
    const model = {
      ...baseModel(),
      provider: "openai",
      api: "openai-responses" as Api,
      baseUrl: "https://api.openai.com/v1",
    };
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("strips /v1 from custom Anthropic proxy baseUrl", () => {
    const model = {
      ...anthropicBase(),
      baseUrl: "https://my-proxy.example.com/anthropic/v1",
    };
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("https://my-proxy.example.com/anthropic");
  });
});

describe("normalizeModelCompat", () => {
  it.each([
    ["z.ai models", undefined],
    [
      "custom moonshot-compatible endpoints",
      { provider: "custom-kimi", baseUrl: "https://api.moonshot.cn/v1" },
    ],
    [
      "DashScope provider ids",
      { provider: "dashscope", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    ],
    [
      "Azure OpenAI chat completions",
      { provider: "azure-openai", baseUrl: "https://my-deployment.openai.azure.com/openai" },
    ],
    [
      "malformed baseUrl values",
      { provider: "custom-cpa", baseUrl: "://api.openai.com malformed" },
    ],
  ] satisfies Array<[string, Partial<Model> | undefined]>)(
    "forces supportsDeveloperRole off for %s",
    (_name, overrides) => {
      expectSupportsDeveloperRoleForcedOff(overrides);
    },
  );

  it.each([
    [
      "DashScope-compatible endpoints regardless of provider id",
      {
        provider: "custom-qwen",
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      },
    ],
    [
      "Moonshot-native endpoints regardless of provider id",
      { provider: "custom-kimi", baseUrl: "https://api.moonshot.ai/v1" },
    ],
  ] satisfies Array<[string, Partial<Model>]>)(
    "keeps supportsUsageInStreaming on for %s",
    (_name, overrides) => {
      expectNativeStreamingSupported(overrides);
    },
  );

  it("leaves native api.openai.com model untouched", () => {
    const model = {
      ...baseModel(),
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(normalized.compat).toBeUndefined();
  });

  it.each([["z.ai models", undefined]] satisfies Array<[string, Partial<Model> | undefined]>)(
    "forces supportsStrictMode off for %s",
    (_name, overrides) => {
      expectSupportsStrictModeForcedOff(overrides);
    },
  );

  it("leaves openai-completions model with empty baseUrl untouched", () => {
    const model = {
      ...baseModel(),
      provider: "openai",
    };
    delete (model as { baseUrl?: unknown }).baseUrl;
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model as Model);
    expect(normalized.compat).toBeUndefined();
  });

  it("respects explicit supportsDeveloperRole true on non-native endpoints", () => {
    const model = {
      ...baseModel(),
      provider: "custom-cpa",
      baseUrl: "https://proxy.example.com/v1",
      compat: { supportsDeveloperRole: true },
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsDeveloperRole(normalized)).toBe(true);
  });

  it("respects explicit supportsUsageInStreaming true on non-native endpoints", () => {
    const model = {
      ...baseModel(),
      provider: "custom-cpa",
      baseUrl: "https://proxy.example.com/v1",
      compat: { supportsUsageInStreaming: true },
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsUsageInStreaming(normalized)).toBe(true);
  });

  it("respects explicit supportsStrictMode true on non-native endpoints", () => {
    const model = {
      ...baseModel(),
      provider: "custom-cpa",
      baseUrl: "https://proxy.example.com/v1",
      compat: { supportsStrictMode: true },
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsStrictMode(normalized)).toBe(true);
  });

  it("does not mutate caller model when forcing supportsDeveloperRole off", () => {
    const model = {
      ...baseModel(),
      provider: "custom-cpa",
      baseUrl: "https://proxy.example.com/v1",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(normalized).not.toBe(model);
    expect(supportsDeveloperRole(model)).toBeUndefined();
    expect(supportsUsageInStreaming(model)).toBeUndefined();
    expect(supportsStrictMode(model)).toBeUndefined();
    expect(supportsDeveloperRole(normalized)).toBe(false);
    expect(supportsUsageInStreaming(normalized)).toBe(false);
    expect(supportsStrictMode(normalized)).toBe(false);
  });

  it("does not override explicit compat false", () => {
    const model = baseModel();
    model.compat = {
      supportsDeveloperRole: false,
      supportsUsageInStreaming: false,
      supportsStrictMode: false,
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsDeveloperRole(normalized)).toBe(false);
    expect(supportsUsageInStreaming(normalized)).toBe(false);
    expect(supportsStrictMode(normalized)).toBe(false);
  });

  it("leaves fully explicit non-native compat untouched", () => {
    const model = baseModel();
    model.baseUrl = "https://proxy.example.com/v1";
    model.compat = {
      supportsDeveloperRole: false,
      supportsUsageInStreaming: true,
      supportsStrictMode: true,
    };
    const normalized = normalizeModelCompat(model);
    expect(normalized).toBe(model);
  });

  it("preserves explicit usage compat when developer role is explicitly enabled", () => {
    const model = baseModel();
    model.baseUrl = "https://proxy.example.com/v1";
    model.compat = {
      supportsDeveloperRole: true,
      supportsUsageInStreaming: true,
      supportsStrictMode: true,
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsDeveloperRole(normalized)).toBe(true);
    expect(supportsUsageInStreaming(normalized)).toBe(true);
    expect(supportsStrictMode(normalized)).toBe(true);
  });
});

describe("isModernModelRef", () => {
  it("uses provider runtime hooks before fallback heuristics", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(false);

    expect(isModernModelRef({ provider: "openrouter", id: "claude-opus-4-6" })).toBe(false);
  });

  it("matches plugin-advertised modern models only for exact provider ids", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockImplementation(
      ({ provider, context }) =>
        provider === "z.ai" && context.modelId === "glm-5" ? true : undefined,
    );

    expect(isModernModelRef({ provider: "z.ai", id: "glm-5" })).toBe(true);
    expect(isModernModelRef({ provider: "z-ai", id: "glm-5" })).toBe(false);
  });
});

describe("isHighSignalLiveModelRef", () => {
  it("keeps modern higher-signal Claude families", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockImplementation(
      ({ provider, context }) =>
        provider === "anthropic" &&
        ["claude-sonnet-4-6", "claude-opus-4-6"].includes(context.modelId)
          ? true
          : undefined,
    );

    expectHighSignal("anthropic", "claude-sonnet-4-6", true);
    expectHighSignal("anthropic", "claude-opus-4-6", true);
  });

  it("drops low-signal or old Claude variants even when provider marks them modern", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(true);

    expectHighSignal("anthropic", "claude-opus-4-5", false);
    expectHighSignal("anthropic", "claude-haiku-4-5-20251001", false);
    expectHighSignal("opencode", "claude-3-5-haiku-20241022", false);
  });

  it("keeps only curated Gemini routes in the default live matrix", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(true);

    expectHighSignal("google", "gemini-2.5-flash-lite", false);
    expectHighSignal("openrouter", "google/gemini-2.5-pro", false);
    expectHighSignal("google", "gemini-3.5-flash", true);
    expectHighSignal("google", "gemini-3-flash-preview", false);
    expectHighSignal("google", "gemini-3-pro-preview", false);
    expectHighSignal("google", "gemini-3.1-pro-preview-customtools", false);
    expectHighSignal("google", "gemma-4-31b-it", false);
    expectHighSignal("google", "gemini-flash-latest", false);
    expectHighSignal("google", "gemini-flash-lite-latest", false);
  });

  it("keeps only the current direct OpenAI-family models in the default live matrix", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(true);

    expectHighSignal("openrouter", "openai/gpt-3.5-turbo", false);
    expectHighSignal("openrouter", "openai/gpt-oss-120b", false);
    expectHighSignal("openrouter", "openai/o1", false);
    expectHighSignal("openai", "gpt-4.1", false);
    expectHighSignal("openai", "gpt-4o", false);
    expectHighSignal("openai", "gpt-5", false);
    expectHighSignal("openai", "gpt-5.1", false);
    expectHighSignal("openai", "gpt-5.4", false);
    expectHighSignal("openai", "gpt-5.5", false);
    for (const id of ["gpt-5.6", "gpt-5.6-sol"]) {
      expectHighSignal("openai", id, false);
    }
    for (const id of ["gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(isHighSignalLiveModelRef({ provider: "openai", id })).toBe(true);
    }
    expectHighSignal("openai", "gpt-5.2-codex", false);
    expectHighSignal("openai", "gpt-5.2-chat-latest", false);
    expectHighSignal("openrouter", "openai/gpt-5.1-chat", false);
    expectHighSignal("opencode", "gpt-5.1-codex-mini", false);
    expectHighSignal("openai", "gpt-5.2", false);
    expectHighSignal("openai", "gpt-5.2-codex", false);
    expectHighSignal("openrouter", "openai/gpt-5.2-chat", true);
  });

  it("drops old MiniMax 2.1 models from the default live matrix", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(true);

    expectHighSignal("minimax", "MiniMax-M2.1", false);
    expectHighSignal("openrouter", "minimax/minimax-m2.1", false);
    expectHighSignal("openrouter", "minimax/minimax-m2.1:free", false);
    expectHighSignal("minimax", "MiniMax-M3", true);
    expectHighSignal("minimax", "MiniMax-M2.7", true);
    expectHighSignal("openrouter", "minimax/minimax-m2.7", true);
  });

  it("keeps only curated OpenRouter routes in the default live matrix", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(true);

    expectHighSignal("openrouter", "openai/gpt-5.2-chat", true);
    expectHighSignal("openrouter", "minimax/minimax-m2.7", true);
    expectHighSignal("openrouter", "ai21/jamba-large-1.7", true);
    expectHighSignal("openrouter", "allenai/olmo-3.1-32b-instruct", false);
    expectHighSignal("openrouter", "amazon/nova-lite-v1", false);
    expectHighSignal("openrouter", "amazon/nova-micro-v1", false);
  });

  it("drops GLM 4.x models from the default live matrix while keeping GLM 5", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(true);

    expectHighSignal("zai", "glm-4.7", false);
    expectHighSignal("fireworks", "accounts/fireworks/models/glm-4p7", false);
    expectHighSignal("fireworks", "accounts/fireworks/models/glm-4p5-air", false);
    expectHighSignal("zai", "glm-5.1", true);
    expectHighSignal("fireworks", "accounts/fireworks/models/glm-5", false);
    expectHighSignal("fireworks", "accounts/fireworks/models/glm-5p1", false);
    expectHighSignal("fireworks", "accounts/fireworks/routers/glm-5p2-fast", true);
    expectHighSignal("fireworks", "accounts/fireworks/models/gpt-oss-120b", false);
    expectHighSignal("fireworks", "accounts/fireworks/models/minimax-m2p7", false);
  });

  it("keeps only curated xAI routes in the default live matrix", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(true);

    expectHighSignal("xai", "grok-4.20-beta-latest-reasoning", false);
    expectHighSignal("xai", "grok-4.20-0309-reasoning", true);
    expectHighSignal("xai", "grok-4.7", true);
    expectHighSignal("xai", "grok-4.6", true);
    expectHighSignal("xai", "grok-4.5", true);
    expectHighSignal("xai", "grok-4.3", false);
    expectHighSignal("xai", "grok-3", false);
    expectHighSignal("xai", "grok-4-1-fast-non-reasoning", false);
    expectHighSignal("xai", "grok-4-fast-non-reasoning", false);
    expectHighSignal("xai", "grok-4-1-fast", false);
  });

  it("keeps DeepSeek V4 models in the default live matrix when the provider marks them modern", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockImplementation(
      ({ provider, context }) =>
        provider === "deepseek" && context.modelId.startsWith("deepseek-v4") ? true : undefined,
    );

    expectHighSignal("deepseek", "deepseek-v4-flash", true);
    expectHighSignal("deepseek", "deepseek-v4-pro", true);
    expectHighSignal("deepseek", "deepseek-chat", false);
  });
});

describe("isPrioritizedHighSignalLiveModelRef", () => {
  it("matches only curated priority entries without invoking provider runtime checks", () => {
    expect(
      isPrioritizedHighSignalLiveModelRef({
        provider: "anthropic",
        id: "claude-sonnet-4-6",
      }),
    ).toBe(true);
    expect(
      isPrioritizedHighSignalLiveModelRef({
        provider: "openrouter",
        id: "amazon/nova-lite-v1",
      }),
    ).toBe(false);
    expect(providerRuntimeMocks.resolveProviderModernModelRef).not.toHaveBeenCalled();
  });

  it("preserves slashes inside prioritized model ids", () => {
    expect(listPrioritizedHighSignalLiveModelRefs()).toContainEqual({
      provider: "fireworks",
      id: "accounts/fireworks/routers/glm-5p2-fast",
    });
  });
});

describe("isSmallLiveModelRef", () => {
  it("matches the small-model live matrix without requiring provider modern hooks", () => {
    expect(isSmallLiveModelRef({ provider: "lmstudio", id: "Qwen/Qwen3.5-9B" })).toBe(true);
    expect(isSmallLiveModelRef({ provider: "ollama", id: "gemma3:4b" })).toBe(true);
    expect(isSmallLiveModelRef({ provider: "openrouter", id: "qwen/qwen3.5-9b" })).toBe(true);
    expect(isSmallLiveModelRef({ provider: "openrouter", id: "z-ai/glm-5.1" })).toBe(true);
    expect(isSmallLiveModelRef({ provider: "openai", id: "gpt-5.5" })).toBe(false);
    expect(providerRuntimeMocks.resolveProviderModernModelRef).not.toHaveBeenCalled();
  });
});

describe("selectHighSignalLiveItems", () => {
  it("prefers curated Google replacements before fallback provider spread", () => {
    const items = [
      { provider: "anthropic", id: "claude-opus-4-8" },
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      { provider: "anthropic", id: "claude-opus-4-7" },
      { provider: "anthropic", id: "claude-opus-4-6" },
      { provider: "google", id: "gemini-3.1-pro-preview" },
      { provider: "google", id: "gemini-3.5-flash" },
      { provider: "deepseek", id: "deepseek-v4-flash" },
      { provider: "openai", id: "gpt-5.5" },
      { provider: "opencode", id: "big-pickle" },
    ];

    expect(
      selectHighSignalLiveItems(
        items,
        4,
        (item) => item,
        (item) => item.provider,
      ),
    ).toEqual([
      { provider: "anthropic", id: "claude-opus-4-8" },
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      { provider: "anthropic", id: "claude-opus-4-7" },
      { provider: "google", id: "gemini-3.1-pro-preview" },
    ]);
  });

  it("prioritizes DeepSeek V4 before later fallback providers", () => {
    const items = [
      { provider: "openai", id: "gpt-5.5" },
      { provider: "deepseek", id: "deepseek-v4-flash" },
      { provider: "deepseek", id: "deepseek-v4-pro" },
      { provider: "minimax", id: "minimax-m3" },
    ];

    expect(
      selectHighSignalLiveItems(
        items,
        3,
        (item) => item,
        (item) => item.provider,
      ),
    ).toEqual([
      { provider: "deepseek", id: "deepseek-v4-flash" },
      { provider: "deepseek", id: "deepseek-v4-pro" },
      { provider: "minimax", id: "minimax-m3" },
    ]);
  });

  it("selects the current Fireworks router instead of unavailable base models", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(true);
    const items = [
      { provider: "fireworks", id: "accounts/fireworks/models/glm-4p7" },
      { provider: "fireworks", id: "accounts/fireworks/models/glm-5" },
      { provider: "fireworks", id: "accounts/fireworks/models/glm-5p1" },
      { provider: "fireworks", id: "accounts/fireworks/routers/glm-5p2-fast" },
      { provider: "fireworks", id: "accounts/fireworks/models/gpt-oss-120b" },
    ].filter(isHighSignalLiveModelRef);

    expect(
      selectHighSignalLiveItems(
        items,
        2,
        (item) => item,
        (item) => item.provider,
      ),
    ).toEqual([{ provider: "fireworks", id: "accounts/fireworks/routers/glm-5p2-fast" }]);
  });
});

describe("selectSmallLiveItems", () => {
  it("prefers constrained local and hosted small-model routes before fallback spread", () => {
    const items = [
      { provider: "openrouter", id: "z-ai/glm-5" },
      { provider: "openai", id: "gpt-5.5" },
      { provider: "vllm", id: "qwen/qwen3-8b" },
      { provider: "lmstudio", id: "qwen/qwen3.5-9b" },
      { provider: "ollama", id: "gemma3:4b" },
      { provider: "openrouter", id: "qwen/qwen3.5-9b" },
    ];

    expect(
      selectSmallLiveItems(
        items,
        3,
        (item) => item,
        (item) => item.provider,
      ),
    ).toEqual([
      { provider: "lmstudio", id: "qwen/qwen3.5-9b" },
      { provider: "vllm", id: "qwen/qwen3-8b" },
      { provider: "ollama", id: "gemma3:4b" },
    ]);
  });
});

describe("resolveHighSignalLiveModelLimit", () => {
  it("defaults modern live sweeps to the curated high-signal cap", () => {
    expect(
      resolveHighSignalLiveModelLimit({
        useExplicitModels: false,
      }),
    ).toBe(DEFAULT_HIGH_SIGNAL_LIVE_MODEL_LIMIT);
  });

  it("can default small live sweeps to the curated small-model cap", () => {
    expect(
      resolveHighSignalLiveModelLimit({
        useExplicitModels: false,
        defaultLimit: DEFAULT_SMALL_LIVE_MODEL_LIMIT,
      }),
    ).toBe(DEFAULT_SMALL_LIVE_MODEL_LIMIT);
  });

  it("leaves explicit model lists uncapped unless a cap is provided", () => {
    expect(
      resolveHighSignalLiveModelLimit({
        useExplicitModels: true,
      }),
    ).toBe(0);
    expect(
      resolveHighSignalLiveModelLimit({
        rawMaxModels: "3",
        useExplicitModels: true,
      }),
    ).toBe(3);
  });
});

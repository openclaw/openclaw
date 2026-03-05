import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { isModernModelRef } from "./live-model-filter.js";
import { normalizeModelCompat } from "./model-compat.js";
import { resolveForwardCompatModel } from "./model-forward-compat.js";

const baseModel = (): Model<Api> =>
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
  }) as Model<Api>;

function supportsDeveloperRole(model: Model<Api>): boolean | undefined {
  return (model.compat as { supportsDeveloperRole?: boolean } | undefined)?.supportsDeveloperRole;
}

function createTemplateModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
    provider,
    api: "anthropic-messages",
    input: ["text"],
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  } as Model<Api>;
}

function createRegistry(models: Record<string, Model<Api>>): ModelRegistry {
  return {
    find(provider: string, modelId: string) {
      return models[`${provider}/${modelId}`] ?? null;
    },
  } as ModelRegistry;
}

function expectSupportsDeveloperRoleForcedOff(overrides?: Partial<Model<Api>>): void {
  const model = { ...baseModel(), ...overrides };
  delete (model as { compat?: unknown }).compat;
  const normalized = normalizeModelCompat(model as Model<Api>);
  expect(supportsDeveloperRole(normalized)).toBe(false);
}

function expectResolvedForwardCompat(
  model: Model<Api> | undefined,
  expected: { provider: string; id: string },
): void {
  expect(model?.id).toBe(expected.id);
  expect(model?.name).toBe(expected.id);
  expect(model?.provider).toBe(expected.provider);
}

describe("normalizeModelCompat — Anthropic baseUrl", () => {
  const anthropicBase = (): Model<Api> =>
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
    }) as Model<Api>;

  it("strips /v1 suffix from anthropic-messages baseUrl", () => {
    const model = { ...anthropicBase(), baseUrl: "https://api.anthropic.com/v1" };
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("https://api.anthropic.com");
  });

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
  it("forces supportsDeveloperRole off for z.ai models", () => {
    expectSupportsDeveloperRoleForcedOff();
  });

  it("forces supportsDeveloperRole off for moonshot models", () => {
    expectSupportsDeveloperRoleForcedOff({
      provider: "moonshot",
      baseUrl: "https://api.moonshot.ai/v1",
    });
  });

  it("forces supportsDeveloperRole off for custom moonshot-compatible endpoints", () => {
    expectSupportsDeveloperRoleForcedOff({
      provider: "custom-kimi",
      baseUrl: "https://api.moonshot.cn/v1",
    });
  });

  it("forces supportsDeveloperRole off for DashScope provider ids", () => {
    expectSupportsDeveloperRoleForcedOff({
      provider: "dashscope",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });
  });

  it("forces supportsDeveloperRole off for DashScope-compatible endpoints", () => {
    expectSupportsDeveloperRoleForcedOff({
      provider: "custom-qwen",
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    });
  });

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

  it("forces supportsDeveloperRole off for Azure OpenAI (Chat Completions, not Responses API)", () => {
    expectSupportsDeveloperRoleForcedOff({
      provider: "azure-openai",
      baseUrl: "https://my-deployment.openai.azure.com/openai",
    });
  });
  it("forces supportsDeveloperRole off for generic custom openai-completions provider", () => {
    expectSupportsDeveloperRoleForcedOff({
      provider: "custom-cpa",
      baseUrl: "https://cpa.example.com/v1",
    });
  });

  it("forces supportsDeveloperRole off for Qwen proxy via openai-completions", () => {
    expectSupportsDeveloperRoleForcedOff({
      provider: "qwen-proxy",
      baseUrl: "https://qwen-api.example.org/compatible-mode/v1",
    });
  });

  it("leaves openai-completions model with empty baseUrl untouched", () => {
    const model = {
      ...baseModel(),
      provider: "openai",
    };
    delete (model as { baseUrl?: unknown }).baseUrl;
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model as Model<Api>);
    expect(normalized.compat).toBeUndefined();
  });

  it("forces supportsDeveloperRole off for malformed baseUrl values", () => {
    expectSupportsDeveloperRoleForcedOff({
      provider: "custom-cpa",
      baseUrl: "://api.openai.com malformed",
    });
  });

  it("overrides explicit supportsDeveloperRole true on non-native endpoints", () => {
    const model = {
      ...baseModel(),
      provider: "custom-cpa",
      baseUrl: "https://proxy.example.com/v1",
      compat: { supportsDeveloperRole: true },
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsDeveloperRole(normalized)).toBe(false);
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
    expect(supportsDeveloperRole(normalized)).toBe(false);
  });

  it("does not override explicit compat false", () => {
    const model = baseModel();
    model.compat = { supportsDeveloperRole: false };
    const normalized = normalizeModelCompat(model);
    expect(supportsDeveloperRole(normalized)).toBe(false);
  });
});

describe("isModernModelRef", () => {
  it("excludes opencode minimax variants from modern selection", () => {
    expect(isModernModelRef({ provider: "opencode", id: "minimax-m2.5" })).toBe(false);
    expect(isModernModelRef({ provider: "opencode", id: "minimax-m2.5" })).toBe(false);
  });

  it("keeps non-minimax opencode modern models", () => {
    expect(isModernModelRef({ provider: "opencode", id: "claude-opus-4-6" })).toBe(true);
    expect(isModernModelRef({ provider: "opencode", id: "gemini-3-pro" })).toBe(true);
  });
});

describe("resolveForwardCompatModel", () => {
  it("resolves anthropic opus 4.6 via 4.5 template", () => {
    const registry = createRegistry({
      "anthropic/claude-opus-4-5": createTemplateModel("anthropic", "claude-opus-4-5"),
    });
    const model = resolveForwardCompatModel("anthropic", "claude-opus-4-6", registry);
    expectResolvedForwardCompat(model, { provider: "anthropic", id: "claude-opus-4-6" });
  });

  it("resolves anthropic sonnet 4.6 dot variant with suffix", () => {
    const registry = createRegistry({
      "anthropic/claude-sonnet-4.5-20260219": createTemplateModel(
        "anthropic",
        "claude-sonnet-4.5-20260219",
      ),
    });
    const model = resolveForwardCompatModel("anthropic", "claude-sonnet-4.6-20260219", registry);
    expectResolvedForwardCompat(model, { provider: "anthropic", id: "claude-sonnet-4.6-20260219" });
  });

  it("does not resolve anthropic 4.6 fallback for other providers", () => {
    const registry = createRegistry({
      "anthropic/claude-opus-4-5": createTemplateModel("anthropic", "claude-opus-4-5"),
    });
    const model = resolveForwardCompatModel("openai", "claude-opus-4-6", registry);
    expect(model).toBeUndefined();
  });

  it("resolves google-antigravity gemini-3.1-pro-preview-customtools via gemini-3-pro-low template", () => {
    const registry = createRegistry({
      "google-antigravity/gemini-3-pro-low": {
        ...createTemplateModel("google-antigravity", "gemini-3-pro-low"),
        api: "openai-completions",
      },
    });
    const model = resolveForwardCompatModel(
      "google-antigravity",
      "gemini-3.1-pro-preview-customtools",
      registry,
    );
    expectResolvedForwardCompat(model, {
      provider: "google-antigravity",
      id: "gemini-3.1-pro-preview-customtools",
    });
  });

  it("resolves google-antigravity gemini-3.1-pro via first available template (gemini-3-pro-low)", () => {
    const registry = createRegistry({
      "google-antigravity/gemini-3-pro-low": createTemplateModel(
        "google-antigravity",
        "gemini-3-pro-low",
      ),
    });
    const model = resolveForwardCompatModel(
      "google-antigravity",
      "gemini-3.1-pro",
      registry,
    );
    expectResolvedForwardCompat(model, {
      provider: "google-antigravity",
      id: "gemini-3.1-pro",
    });
  });

  it("falls back to gemini-3-pro-high when gemini-3-pro-low is not in registry", () => {
    const registry = createRegistry({
      "google-antigravity/gemini-3-pro-high": createTemplateModel(
        "google-antigravity",
        "gemini-3-pro-high",
      ),
    });
    const model = resolveForwardCompatModel(
      "google-antigravity",
      "gemini-3.1-pro-preview-customtools",
      registry,
    );
    expectResolvedForwardCompat(model, {
      provider: "google-antigravity",
      id: "gemini-3.1-pro-preview-customtools",
    });
  });

  it("resolves google-antigravity gemini-3.1-flash via gemini-3-flash template", () => {
    const registry = createRegistry({
      "google-antigravity/gemini-3-flash": createTemplateModel(
        "google-antigravity",
        "gemini-3-flash",
      ),
    });
    const model = resolveForwardCompatModel(
      "google-antigravity",
      "gemini-3.1-flash-preview",
      registry,
    );
    expectResolvedForwardCompat(model, {
      provider: "google-antigravity",
      id: "gemini-3.1-flash-preview",
    });
  });

  it("does not resolve google-antigravity for non-3.1 models", () => {
    const registry = createRegistry({
      "google-antigravity/gemini-3-pro-low": createTemplateModel(
        "google-antigravity",
        "gemini-3-pro-low",
      ),
    });
    const model = resolveForwardCompatModel(
      "google-antigravity",
      "gemini-3-pro-low",
      registry,
    );
    expect(model).toBeUndefined();
  });

  it("does not resolve google-antigravity forward-compat for other providers", () => {
    const registry = createRegistry({
      "google-antigravity/gemini-3-pro-low": createTemplateModel(
        "google-antigravity",
        "gemini-3-pro-low",
      ),
    });
    const model = resolveForwardCompatModel(
      "openai",
      "gemini-3.1-pro-preview-customtools",
      registry,
    );
    expect(model).toBeUndefined();
  });

  it("returns undefined when no antigravity template exists in registry", () => {
    const registry = createRegistry({});
    const model = resolveForwardCompatModel(
      "google-antigravity",
      "gemini-3.1-pro-preview-customtools",
      registry,
    );
    expect(model).toBeUndefined();
  });
});

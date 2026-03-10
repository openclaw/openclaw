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

function supportsUsageInStreaming(model: Model<Api>): boolean | undefined {
  return (model.compat as { supportsUsageInStreaming?: boolean } | undefined)
    ?.supportsUsageInStreaming;
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

function createOpenAITemplateModel(id: string): Model<Api> {
  return {
    id,
    name: id,
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    input: ["text", "image"],
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400_000,
    maxTokens: 32_768,
  } as Model<Api>;
}

function createOpenAICodexTemplateModel(id: string): Model<Api> {
  return {
    id,
    name: id,
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    input: ["text", "image"],
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
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

function expectSupportsUsageInStreamingForcedOff(overrides?: Partial<Model<Api>>): void {
  const model = { ...baseModel(), ...overrides };
  delete (model as { compat?: unknown }).compat;
  const normalized = normalizeModelCompat(model as Model<Api>);
  expect(supportsUsageInStreaming(normalized)).toBe(false);
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

  it("forces supportsUsageInStreaming off for generic custom openai-completions provider", () => {
    expectSupportsUsageInStreamingForcedOff({
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

  it("overrides explicit supportsUsageInStreaming true on non-native endpoints", () => {
    const model = {
      ...baseModel(),
      provider: "custom-cpa",
      baseUrl: "https://proxy.example.com/v1",
      compat: { supportsUsageInStreaming: true },
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsUsageInStreaming(normalized)).toBe(false);
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
    expect(supportsDeveloperRole(normalized)).toBe(false);
    expect(supportsUsageInStreaming(normalized)).toBe(false);
  });

  it("does not override explicit compat false", () => {
    const model = baseModel();
    model.compat = { supportsDeveloperRole: false, supportsUsageInStreaming: false };
    const normalized = normalizeModelCompat(model);
    expect(supportsDeveloperRole(normalized)).toBe(false);
    expect(supportsUsageInStreaming(normalized)).toBe(false);
  });
});

describe("isModernModelRef", () => {
  it("includes OpenAI gpt-5.4 variants in modern selection", () => {
    expect(isModernModelRef({ provider: "openai", id: "gpt-5.4" })).toBe(true);
    expect(isModernModelRef({ provider: "openai", id: "gpt-5.4-pro" })).toBe(true);
    expect(isModernModelRef({ provider: "openai-codex", id: "gpt-5.4" })).toBe(true);
  });

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
  it("resolves openai gpt-5.4 via gpt-5.2 template", () => {
    const registry = createRegistry({
      "openai/gpt-5.2": createOpenAITemplateModel("gpt-5.2"),
    });
    const model = resolveForwardCompatModel("openai", "gpt-5.4", registry);
    expectResolvedForwardCompat(model, { provider: "openai", id: "gpt-5.4" });
    expect(model?.api).toBe("openai-responses");
    expect(model?.baseUrl).toBe("https://api.openai.com/v1");
    expect(model?.contextWindow).toBe(1_050_000);
    expect(model?.maxTokens).toBe(128_000);
  });

  it("resolves openai gpt-5.4 without templates using normalized fallback defaults", () => {
    const registry = createRegistry({});

    const model = resolveForwardCompatModel("openai", "gpt-5.4", registry);

    expectResolvedForwardCompat(model, { provider: "openai", id: "gpt-5.4" });
    expect(model?.api).toBe("openai-responses");
    expect(model?.baseUrl).toBe("https://api.openai.com/v1");
    expect(model?.input).toEqual(["text", "image"]);
    expect(model?.reasoning).toBe(true);
    expect(model?.contextWindow).toBe(1_050_000);
    expect(model?.maxTokens).toBe(128_000);
    expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("resolves openai gpt-5.4-pro via template fallback", () => {
    const registry = createRegistry({
      "openai/gpt-5.2": createOpenAITemplateModel("gpt-5.2"),
    });
    const model = resolveForwardCompatModel("openai", "gpt-5.4-pro", registry);
    expectResolvedForwardCompat(model, { provider: "openai", id: "gpt-5.4-pro" });
    expect(model?.api).toBe("openai-responses");
    expect(model?.baseUrl).toBe("https://api.openai.com/v1");
    expect(model?.contextWindow).toBe(1_050_000);
    expect(model?.maxTokens).toBe(128_000);
  });

  it("resolves openai-codex gpt-5.4 via codex template fallback", () => {
    const registry = createRegistry({
      "openai-codex/gpt-5.2-codex": createOpenAICodexTemplateModel("gpt-5.2-codex"),
    });
    const model = resolveForwardCompatModel("openai-codex", "gpt-5.4", registry);
    expectResolvedForwardCompat(model, { provider: "openai-codex", id: "gpt-5.4" });
    expect(model?.api).toBe("openai-codex-responses");
    expect(model?.baseUrl).toBe("https://chatgpt.com/backend-api");
    expect(model?.contextWindow).toBe(1_050_000);
    expect(model?.maxTokens).toBe(128_000);
  });

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
});

// ─── isLocalInferenceEndpoint ────────────────────────────────────────────────

import { isLocalInferenceEndpoint } from "./model-compat.js";

describe("isLocalInferenceEndpoint", () => {
  // Loopback
  it("matches localhost", () =>
    expect(isLocalInferenceEndpoint("http://localhost:8080/v1")).toBe(true));
  it("matches 127.0.0.1", () =>
    expect(isLocalInferenceEndpoint("http://127.0.0.1:8080/v1")).toBe(true));
  it("matches full 127.x.x.x/8 range — 127.0.0.2", () =>
    expect(isLocalInferenceEndpoint("http://127.0.0.2/v1")).toBe(true));
  it("matches full 127.x.x.x/8 range — 127.255.255.254", () =>
    expect(isLocalInferenceEndpoint("http://127.255.255.254/v1")).toBe(true));
  it("matches IPv6 loopback [::1]", () =>
    expect(isLocalInferenceEndpoint("http://[::1]:8080/v1")).toBe(true));

  // RFC-1918
  it("matches 10.x", () => expect(isLocalInferenceEndpoint("http://10.0.0.1/v1")).toBe(true));
  it("matches 192.168.x (e.g. DGX Spark)", () =>
    expect(isLocalInferenceEndpoint("http://192.168.1.152:8002/v1")).toBe(true));
  it("matches 172.16.x (lower bound of /12)", () =>
    expect(isLocalInferenceEndpoint("http://172.16.0.1/v1")).toBe(true));
  it("matches 172.31.x (upper bound of /12)", () =>
    expect(isLocalInferenceEndpoint("http://172.31.255.1/v1")).toBe(true));
  it("does NOT match 172.15.x (just below /12 range)", () =>
    expect(isLocalInferenceEndpoint("http://172.15.0.1/v1")).toBe(false));
  it("does NOT match 172.32.x (just above /12 range)", () =>
    expect(isLocalInferenceEndpoint("http://172.32.0.1/v1")).toBe(false));

  // Link-local
  it("matches 169.254.x", () =>
    expect(isLocalInferenceEndpoint("http://169.254.1.1/v1")).toBe(true));

  // mDNS
  it("matches *.local hostnames", () =>
    expect(isLocalInferenceEndpoint("http://spark-38f8.local:8002/v1")).toBe(true));
  it("matches single-label .local", () =>
    expect(isLocalInferenceEndpoint("http://raspberrypi.local/v1")).toBe(true));

  // Public/remote — must return false
  it("rejects api.openai.com", () =>
    expect(isLocalInferenceEndpoint("https://api.openai.com/v1")).toBe(false));
  it("rejects api.anthropic.com", () =>
    expect(isLocalInferenceEndpoint("https://api.anthropic.com")).toBe(false));
  it("rejects public IP 8.8.8.8", () =>
    expect(isLocalInferenceEndpoint("http://8.8.8.8/v1")).toBe(false));
  it("rejects Azure OpenAI endpoint", () =>
    expect(isLocalInferenceEndpoint("https://my-resource.openai.azure.com/v1")).toBe(false));
  it("rejects Groq", () =>
    expect(isLocalInferenceEndpoint("https://api.groq.com/openai/v1")).toBe(false));
  it("rejects DeepSeek", () =>
    expect(isLocalInferenceEndpoint("https://api.deepseek.com/v1")).toBe(false));
  it("returns false for empty string", () => expect(isLocalInferenceEndpoint("")).toBe(false));
  it("returns false for invalid URL", () =>
    expect(isLocalInferenceEndpoint("not-a-url")).toBe(false));
});

// ─── normalizeModelCompat — local inference endpoints ────────────────────────

describe("normalizeModelCompat — local inference endpoints", () => {
  function localModel(baseUrl: string): Model<Api> {
    return {
      id: "Qwen3.5-35B",
      name: "Qwen3.5-35B",
      api: "openai-completions",
      provider: "local-dgx-spark",
      baseUrl,
      input: ["text"],
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 4096,
    } as Model<Api>;
  }

  it("disables developer role but does NOT force supportsUsageInStreaming false for localhost", () => {
    const result = normalizeModelCompat(localModel("http://localhost:11434/v1"));
    const compat = result.compat as Record<string, boolean> | undefined;
    expect(compat?.supportsDeveloperRole).toBe(false);
    expect(compat?.supportsUsageInStreaming).toBeUndefined();
  });

  it("disables developer role but does NOT force supportsUsageInStreaming false for 192.168.x", () => {
    const result = normalizeModelCompat(localModel("http://192.168.1.152:8002/v1"));
    const compat = result.compat as Record<string, boolean> | undefined;
    expect(compat?.supportsDeveloperRole).toBe(false);
    expect(compat?.supportsUsageInStreaming).toBeUndefined();
  });

  it("treats 127.0.0.2 (non-standard loopback) as local", () => {
    const result = normalizeModelCompat(localModel("http://127.0.0.2:8080/v1"));
    const compat = result.compat as Record<string, boolean> | undefined;
    expect(compat?.supportsDeveloperRole).toBe(false);
    expect(compat?.supportsUsageInStreaming).toBeUndefined();
  });

  it("treats *.local mDNS addresses as local", () => {
    const result = normalizeModelCompat(localModel("http://spark-38f8.local:8002/v1"));
    const compat = result.compat as Record<string, boolean> | undefined;
    expect(compat?.supportsDeveloperRole).toBe(false);
    expect(compat?.supportsUsageInStreaming).toBeUndefined();
  });

  it("preserves explicitly configured supportsUsageInStreaming: true for local endpoints", () => {
    const model = {
      ...localModel("http://localhost:8080/v1"),
      compat: { supportsUsageInStreaming: true },
    };
    const result = normalizeModelCompat(model);
    const compat = result.compat as Record<string, boolean> | undefined;
    expect(compat?.supportsUsageInStreaming).toBe(true);
    expect(compat?.supportsDeveloperRole).toBe(false);
  });

  it("is idempotent when supportsDeveloperRole already false for local endpoint", () => {
    const model = {
      ...localModel("http://localhost:8080/v1"),
      compat: { supportsDeveloperRole: false },
    };
    const result = normalizeModelCompat(model);
    expect(result).toBe(model);
  });
});

// ─── normalizeModelCompat — remote non-native endpoints ──────────────────────

describe("normalizeModelCompat — remote non-native endpoints", () => {
  function remoteModel(baseUrl: string): Model<Api> {
    return {
      id: "glm-5",
      name: "GLM-5",
      api: "openai-completions",
      provider: "zai",
      baseUrl,
      input: ["text"],
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    } as Model<Api>;
  }

  it("forces BOTH developer role AND streaming usage off for remote non-native endpoints", () => {
    for (const url of [
      "https://api.deepseek.com/v1",
      "https://api.groq.com/openai/v1",
      "https://api.z.ai/api/paas/v4",
      "https://my-resource.openai.azure.com/v1",
    ]) {
      const result = normalizeModelCompat(remoteModel(url));
      const compat = result.compat as Record<string, boolean> | undefined;
      expect(compat?.supportsDeveloperRole, `supportsDeveloperRole for ${url}`).toBe(false);
      expect(compat?.supportsUsageInStreaming, `supportsUsageInStreaming for ${url}`).toBe(false);
    }
  });
});

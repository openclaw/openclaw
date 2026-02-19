import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { getApiKeyForModel } from "../model-auth.js";
import {
  resolveCompactionModelForRun,
  resolveCompactionOverrideModelRef,
} from "./compact-model-selection.js";
import { resolveModel } from "./model.js";

type ResolveModelFn = typeof resolveModel;
type ResolveModelResult = ReturnType<ResolveModelFn>;
type RuntimeModel = NonNullable<ResolveModelResult["model"]>;

function makeConfig(rawModels: Record<string, { alias?: string }>): OpenClawConfig {
  return {
    agents: {
      defaults: {
        models: rawModels,
      },
    },
  } as OpenClawConfig;
}

function makeConfigWithDefaults(params: {
  modelPrimary?: string;
  rawModels: Record<string, { alias?: string }>;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        ...(params.modelPrimary ? { model: { primary: params.modelPrimary } } : {}),
        models: params.rawModels,
      },
    },
  } as OpenClawConfig;
}

function makeRuntimeModel(provider: string, id: string): RuntimeModel {
  return {
    id,
    name: id,
    provider,
    api: "messages",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  } as RuntimeModel;
}

function makeResolveSuccess(provider: string, id: string): ResolveModelResult {
  return {
    model: makeRuntimeModel(provider, id),
    authStorage: {
      setRuntimeApiKey: vi.fn(),
    } as unknown as ResolveModelResult["authStorage"],
    modelRegistry: {} as ResolveModelResult["modelRegistry"],
  };
}

describe("resolveCompactionOverrideModelRef", () => {
  it("resolves configured aliases", () => {
    const cfg = makeConfig({
      "anthropic/claude-sonnet-4-6": { alias: "cheap-sonnet" },
    });
    const resolved = resolveCompactionOverrideModelRef({
      raw: "cheap-sonnet",
      cfg,
      defaultProvider: "anthropic",
    });
    expect("error" in resolved).toBe(false);
    if ("error" in resolved) {
      return;
    }
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.modelId).toBe("claude-sonnet-4-6");
    expect(resolved.source).toBe("alias");
  });

  it("resolves explicit provider/model references", () => {
    const cfg = makeConfig({
      "openai/gpt-4.1-mini": {},
    });
    const resolved = resolveCompactionOverrideModelRef({
      raw: "openai/gpt-4.1-mini",
      cfg,
      defaultProvider: "anthropic",
    });
    expect("error" in resolved).toBe(false);
    if ("error" in resolved) {
      return;
    }
    expect(resolved.provider).toBe("openai");
    expect(resolved.modelId).toBe("gpt-4.1-mini");
    expect(resolved.source).toBe("provider/model");
  });

  it("rejects models missing from agents.defaults.models", () => {
    const cfg = makeConfig({
      "anthropic/claude-opus-4-6": {},
    });
    const resolved = resolveCompactionOverrideModelRef({
      raw: "anthropic/claude-sonnet-4-6",
      cfg,
      defaultProvider: "anthropic",
    });
    expect("error" in resolved).toBe(true);
    if (!("error" in resolved)) {
      return;
    }
    expect(resolved.error).toContain("model not configured in agents.defaults.models");
  });

  it("rejects bare non-alias model ids", () => {
    const cfg = makeConfig({
      "anthropic/claude-sonnet-4-6": {},
    });
    const resolved = resolveCompactionOverrideModelRef({
      raw: "claude-sonnet-4-6",
      cfg,
      defaultProvider: "anthropic",
    });
    expect("error" in resolved).toBe(true);
    if (!("error" in resolved)) {
      return;
    }
    expect(resolved.error).toContain("expected provider/model or configured alias");
  });
});

describe("resolveCompactionModelForRun", () => {
  it("uses the session model when no override is configured", async () => {
    const resolveModelFn = vi.fn((provider: string, modelId: string) => {
      expect(provider).toBe("anthropic");
      expect(modelId).toBe("claude-opus-4-6");
      return makeResolveSuccess(provider, modelId);
    });
    const getApiKeyForModelFn = vi.fn(async () => ({
      apiKey: "session-key",
      source: "test",
      mode: "api-key" as const,
    }));
    const resolved = await resolveCompactionModelForRun({
      sessionProvider: "anthropic",
      sessionModelId: "claude-opus-4-6",
      cfg: makeConfig({
        "anthropic/claude-opus-4-6": {},
      }),
      agentDir: "/tmp/agent",
      authProfileId: "session-profile",
      resolveModelFn: resolveModelFn as ResolveModelFn,
      getApiKeyForModelFn: getApiKeyForModelFn as typeof getApiKeyForModel,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(resolved.value.overrideUsed).toBe(false);
    expect(resolved.value.provider).toBe("anthropic");
    expect(resolved.value.modelId).toBe("claude-opus-4-6");
    expect(resolveModelFn).toHaveBeenCalledTimes(1);
    expect(getApiKeyForModelFn).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "session-profile",
      }),
    );
  });

  it("uses a configured alias override and logs the selected model", async () => {
    const infos: string[] = [];
    const warns: string[] = [];
    const resolveModelFn = vi.fn((provider: string, modelId: string) =>
      makeResolveSuccess(provider, modelId),
    );
    const getApiKeyForModelFn = vi.fn(async () => ({
      apiKey: "override-key",
      source: "test",
      mode: "api-key" as const,
    }));
    const resolved = await resolveCompactionModelForRun({
      sessionProvider: "anthropic",
      sessionModelId: "claude-opus-4-6",
      overrideRaw: "cheap-sonnet",
      cfg: makeConfig({
        "anthropic/claude-opus-4-6": {},
        "anthropic/claude-sonnet-4-6": { alias: "cheap-sonnet" },
      }),
      agentDir: "/tmp/agent",
      authProfileId: "session-profile",
      logInfo: (message) => infos.push(message),
      logWarn: (message) => warns.push(message),
      resolveModelFn: resolveModelFn as ResolveModelFn,
      getApiKeyForModelFn: getApiKeyForModelFn as typeof getApiKeyForModel,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(resolved.value.overrideUsed).toBe(true);
    expect(resolved.value.provider).toBe("anthropic");
    expect(resolved.value.modelId).toBe("claude-sonnet-4-6");
    expect(infos).toContain(
      "[compaction] using override model anthropic/claude-sonnet-4-6 (session model: anthropic/claude-opus-4-6)",
    );
    expect(warns).toEqual([]);
    expect(getApiKeyForModelFn).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "session-profile",
      }),
    );
  });

  it("uses explicit provider/model override when configured", async () => {
    const resolveModelFn = vi.fn((provider: string, modelId: string) =>
      makeResolveSuccess(provider, modelId),
    );
    const getApiKeyForModelFn = vi.fn(async () => ({
      apiKey: "override-key",
      source: "test",
      mode: "api-key" as const,
    }));
    const resolved = await resolveCompactionModelForRun({
      sessionProvider: "anthropic",
      sessionModelId: "claude-opus-4-6",
      overrideRaw: "anthropic/claude-sonnet-4-6",
      cfg: makeConfig({
        "anthropic/claude-opus-4-6": {},
        "anthropic/claude-sonnet-4-6": {},
      }),
      agentDir: "/tmp/agent",
      authProfileId: "session-profile",
      resolveModelFn: resolveModelFn as ResolveModelFn,
      getApiKeyForModelFn: getApiKeyForModelFn as typeof getApiKeyForModel,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(resolved.value.overrideUsed).toBe(true);
    expect(resolved.value.provider).toBe("anthropic");
    expect(resolved.value.modelId).toBe("claude-sonnet-4-6");
  });

  it("falls back to the session model when override is not in configured catalog", async () => {
    const warns: string[] = [];
    const resolveModelFn = vi.fn((provider: string, modelId: string) =>
      makeResolveSuccess(provider, modelId),
    );
    const getApiKeyForModelFn = vi.fn(async () => ({
      apiKey: "session-key",
      source: "test",
      mode: "api-key" as const,
    }));
    const resolved = await resolveCompactionModelForRun({
      sessionProvider: "anthropic",
      sessionModelId: "claude-opus-4-6",
      overrideRaw: "anthropic/claude-sonnet-4-6",
      cfg: makeConfig({
        "anthropic/claude-opus-4-6": {},
      }),
      agentDir: "/tmp/agent",
      authProfileId: "session-profile",
      logWarn: (message) => warns.push(message),
      resolveModelFn: resolveModelFn as ResolveModelFn,
      getApiKeyForModelFn: getApiKeyForModelFn as typeof getApiKeyForModel,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(resolved.value.overrideUsed).toBe(false);
    expect(resolveModelFn).toHaveBeenCalledTimes(1);
    expect(warns[0]).toContain("using session model anthropic/claude-opus-4-6");
  });

  it("falls back when override model resolution fails", async () => {
    const warns: string[] = [];
    const resolveModelFn = vi.fn((provider: string, modelId: string) => {
      if (provider === "anthropic" && modelId === "claude-sonnet-4-6") {
        return {
          error: "Unknown model: anthropic/claude-sonnet-4-6",
          authStorage: {
            setRuntimeApiKey: vi.fn(),
          } as unknown as ResolveModelResult["authStorage"],
          modelRegistry: {} as ResolveModelResult["modelRegistry"],
        } as ResolveModelResult;
      }
      return makeResolveSuccess(provider, modelId);
    });
    const getApiKeyForModelFn = vi.fn(async () => ({
      apiKey: "session-key",
      source: "test",
      mode: "api-key" as const,
    }));
    const resolved = await resolveCompactionModelForRun({
      sessionProvider: "anthropic",
      sessionModelId: "claude-opus-4-6",
      overrideRaw: "anthropic/claude-sonnet-4-6",
      cfg: makeConfig({
        "anthropic/claude-opus-4-6": {},
        "anthropic/claude-sonnet-4-6": {},
      }),
      agentDir: "/tmp/agent",
      authProfileId: "session-profile",
      logWarn: (message) => warns.push(message),
      resolveModelFn: resolveModelFn as ResolveModelFn,
      getApiKeyForModelFn: getApiKeyForModelFn as typeof getApiKeyForModel,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(resolved.value.overrideUsed).toBe(false);
    expect(resolveModelFn).toHaveBeenCalledTimes(2);
    expect(warns.some((entry) => entry.includes("unavailable"))).toBe(true);
  });

  it("falls back when override authentication fails", async () => {
    const warns: string[] = [];
    const resolveModelFn = vi.fn((provider: string, modelId: string) =>
      makeResolveSuccess(provider, modelId),
    );
    const getApiKeyForModelFn = vi.fn(async (params: { model: { id: string } }) => {
      if (params.model.id === "claude-sonnet-4-6") {
        throw new Error("Invalid override API key");
      }
      return {
        apiKey: "session-key",
        source: "test",
        mode: "api-key" as const,
      };
    });
    const resolved = await resolveCompactionModelForRun({
      sessionProvider: "anthropic",
      sessionModelId: "claude-opus-4-6",
      overrideRaw: "anthropic/claude-sonnet-4-6",
      cfg: makeConfig({
        "anthropic/claude-opus-4-6": {},
        "anthropic/claude-sonnet-4-6": {},
      }),
      agentDir: "/tmp/agent",
      authProfileId: "session-profile",
      logWarn: (message) => warns.push(message),
      resolveModelFn: resolveModelFn as ResolveModelFn,
      getApiKeyForModelFn: getApiKeyForModelFn as typeof getApiKeyForModel,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(resolved.value.overrideUsed).toBe(false);
    expect(warns.some((entry) => entry.includes("Invalid override API key"))).toBe(true);
  });

  it("does not lock override auth profile when provider differs from the session", async () => {
    const resolveModelFn = vi.fn((provider: string, modelId: string) =>
      makeResolveSuccess(provider, modelId),
    );
    const getApiKeyForModelFn = vi.fn(async () => ({
      apiKey: "override-key",
      source: "test",
      mode: "api-key" as const,
    }));
    const resolved = await resolveCompactionModelForRun({
      sessionProvider: "anthropic",
      sessionModelId: "claude-opus-4-6",
      overrideRaw: "openai/gpt-4.1-mini",
      cfg: makeConfig({
        "anthropic/claude-opus-4-6": {},
        "openai/gpt-4.1-mini": {},
      }),
      agentDir: "/tmp/agent",
      authProfileId: "anthropic-profile",
      resolveModelFn: resolveModelFn as ResolveModelFn,
      getApiKeyForModelFn: getApiKeyForModelFn as typeof getApiKeyForModel,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(resolved.value.overrideUsed).toBe(true);
    expect(resolved.value.provider).toBe("openai");
    expect(getApiKeyForModelFn).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: undefined,
      }),
    );
  });

  it("resolves providerless aliases with config default provider (not session provider)", async () => {
    const infos: string[] = [];
    const resolveModelFn = vi.fn((provider: string, modelId: string) => {
      if (provider === "openai" && modelId === "claude-sonnet-4-6") {
        return {
          error: "Unknown model: openai/claude-sonnet-4-6",
          authStorage: {
            setRuntimeApiKey: vi.fn(),
          } as unknown as ResolveModelResult["authStorage"],
          modelRegistry: {} as ResolveModelResult["modelRegistry"],
        } as ResolveModelResult;
      }
      return makeResolveSuccess(provider, modelId);
    });
    const getApiKeyForModelFn = vi.fn(async () => ({
      apiKey: "key",
      source: "test",
      mode: "api-key" as const,
    }));

    const resolved = await resolveCompactionModelForRun({
      sessionProvider: "openai",
      sessionModelId: "gpt-4.1-mini",
      overrideRaw: "cheap-sonnet",
      cfg: makeConfigWithDefaults({
        modelPrimary: "anthropic/claude-opus-4-6",
        rawModels: {
          "claude-opus-4-6": { alias: "opus" },
          "claude-sonnet-4-6": { alias: "cheap-sonnet" },
          "openai/gpt-4.1-mini": {},
        },
      }),
      agentDir: "/tmp/agent",
      authProfileId: "openai-profile",
      logInfo: (message) => infos.push(message),
      resolveModelFn: resolveModelFn as ResolveModelFn,
      getApiKeyForModelFn: getApiKeyForModelFn as typeof getApiKeyForModel,
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(resolved.value.overrideUsed).toBe(true);
    expect(resolved.value.provider).toBe("anthropic");
    expect(resolved.value.modelId).toBe("claude-sonnet-4-6");
    expect(infos).toContain(
      "[compaction] using override model anthropic/claude-sonnet-4-6 (session model: openai/gpt-4.1-mini)",
    );
  });
});

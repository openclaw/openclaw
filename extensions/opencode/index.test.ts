// Opencode tests cover index plugin behavior.
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  registerProviderPlugin,
  registerSingleProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { NON_ENV_SECRETREF_MARKER } from "openclaw/plugin-sdk/provider-auth-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { expectPassthroughReplayPolicy } from "openclaw/plugin-sdk/provider-test-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildOpencodeZenLiveProviderConfig } from "./provider-catalog.js";

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

function requireMapEntry<T>(map: Map<string, T>, id: string): T {
  const entry = map.get(id);
  if (!entry) {
    throw new Error(`expected model ${id}`);
  }
  return entry;
}

function requireCatalogEntry(entries: readonly unknown[] | null | undefined, id: string) {
  if (!entries) {
    throw new Error("expected supplemental catalog entries");
  }
  const entry = entries.find((candidate) => requireRecord(candidate, "catalog entry").id === id);
  if (!entry) {
    throw new Error(`expected supplemental catalog entry ${id}`);
  }
  return requireRecord(entry, `supplemental catalog entry ${id}`);
}

describe("opencode provider plugin", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });
  it("registers image media understanding through the OpenCode plugin", async () => {
    const { mediaProviders } = await registerProviderPlugin({
      plugin,
      id: "opencode",
      name: "OpenCode Zen Provider",
    });

    const mediaProvider = mediaProviders.find((provider) => provider.id === "opencode");
    if (!mediaProvider) {
      throw new Error("Expected opencode media provider");
    }
    expect(mediaProvider.capabilities).toEqual(["image"]);
    expect(mediaProvider.defaultModels).toEqual({ image: "gpt-5-nano" });
    expect(typeof mediaProvider.describeImage).toBe("function");
    expect(typeof mediaProvider.describeImages).toBe("function");
  });

  it("owns passthrough-gemini replay policy for Gemini-backed models", async () => {
    await expectPassthroughReplayPolicy({
      plugin,
      providerId: "opencode",
      modelId: "gemini-2.5-pro",
      sanitizeThoughtSignatures: true,
    });
  });

  it("keeps non-Gemini replay policy minimal on passthrough routes", async () => {
    await expectPassthroughReplayPolicy({
      plugin,
      providerId: "opencode",
      modelId: "claude-opus-4.6",
    });
  });

  it("keeps OpenCode Zen catalog coverage aligned with the curated seed", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    expect(provider.catalog).toBeDefined();

    const expectedModelIds = [
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ];
    const models = new Map<string, ProviderRuntimeModel>();
    for (const modelId of expectedModelIds) {
      const model = provider.resolveDynamicModel?.({ modelId } as never);
      if (!model) {
        throw new Error(`expected OpenCode Zen model ${modelId}`);
      }
      models.set(model.id, model);
    }
    expect([...models.keys()]).toEqual(expectedModelIds);

    const supplemental = await provider.augmentModelCatalog?.({
      entries: [...models.values()].map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
      })),
    } as never);
    const opus48 = requireCatalogEntry(supplemental, "claude-opus-4-8");
    expect(opus48.provider).toBe("opencode");
    expect(opus48.name).toBe("Claude Opus 4.8");

    const opus46 = requireMapEntry(models, "claude-opus-4-6");
    expect(opus46.api).toBe("openai-completions");
    expect(opus46.baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(opus46.input).toEqual(["text", "image"]);
    expect(opus46.reasoning).toBe(true);
    expect(opus46.contextWindow).toBe(200_000);
    expect(opus46.maxTokens).toBe(65_536);

    const dynamicModel = requireRecord(
      provider.resolveDynamicModel?.({
        modelId: "claude-opus-4-8",
      } as never),
      "dynamic model",
    );
    expect(dynamicModel.id).toBe("claude-opus-4-8");
    expect(dynamicModel.api).toBe("openai-completions");
    expect(dynamicModel.provider).toBe("opencode");
    expect(dynamicModel.baseUrl).toBe("https://opencode.ai/zen/v1");
    const compat = requireRecord(dynamicModel.compat, "dynamic model compat");
    expect(compat.supportsUsageInStreaming).toBe(true);
    expect(compat.supportsReasoningEffort).toBe(true);
    expect(compat.maxTokensField).toBe("max_tokens");
  });

  it("loads OpenCode Zen model discovery through the provider runtime", () => {
    expect(manifest.modelCatalog.discovery.opencode).toBe("runtime");
  });

  it("skips live OpenCode Zen catalog discovery when no shared key is configured", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    await expect(
      provider.catalog?.run({
        config: {},
        env: {},
        resolveProviderApiKey: () => ({ apiKey: undefined }),
        resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
      } as never),
    ).resolves.toBeNull();
  });

  it("does not mix provider-specific runtime auth with shared discovery auth", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("blocked fetch"));

    try {
      const result = await provider.catalog?.run({
        config: {},
        env: {},
        resolveProviderApiKey: (providerId: string) =>
          providerId === "opencode"
            ? {
                apiKey: NON_ENV_SECRETREF_MARKER,
                discoveryApiKey: undefined,
              }
            : {
                apiKey: "shared-opencode-key",
                discoveryApiKey: "shared-opencode-key",
              },
        resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
      } as never);

      if (!result || !("provider" in result)) {
        throw new Error("expected OpenCode Zen provider result");
      }
      expect(result.provider.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
      expect(result.provider.models.map((model) => model.id)).toContain("claude-opus-4-8");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("uses cached live OpenCode Zen discovery and synthesizes live-only rows", async () => {
    const fetchGuard = vi.fn(async () => ({
      response: new Response(
        JSON.stringify({
          data: [
            { id: "claude-opus-4-8", object: "model" },
            { id: "gpt-5.5", object: "model" },
          ],
        }),
      ),
      finalUrl: "https://opencode.ai/zen/v1/models",
      release: vi.fn(async () => undefined),
    }));

    const first = await buildOpencodeZenLiveProviderConfig({
      apiKey: "OPENCODE_API_KEY",
      discoveryApiKey: "resolved-opencode-key",
      fetchGuard,
    });
    const second = await buildOpencodeZenLiveProviderConfig({
      apiKey: "OPENCODE_API_KEY",
      discoveryApiKey: "resolved-opencode-key",
      fetchGuard,
    });

    expect(fetchGuard).toHaveBeenCalledTimes(1);
    expect(first.apiKey).toBe("OPENCODE_API_KEY");
    expect(first.models.map((model) => model.id)).toEqual(["claude-opus-4-8", "gpt-5.5"]);
    expect(second.models.map((model) => model.id)).toEqual(["claude-opus-4-8", "gpt-5.5"]);
    const liveOnlyModel = first.models.find((model) => model.id === "gpt-5.5");
    expect(liveOnlyModel).toMatchObject({
      name: "GPT-5.5",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/v1",
      provider: "opencode",
      contextWindow: 400_000,
      maxTokens: 128_000,
    });

    clearLiveCatalogCacheForTests();
    fetchGuard.mockRejectedValueOnce(new Error("network unavailable"));
    const fallback = await buildOpencodeZenLiveProviderConfig({
      apiKey: "OPENCODE_API_KEY",
      discoveryApiKey: "resolved-opencode-key",
      fetchGuard,
    });
    expect(fallback.apiKey).toBe("OPENCODE_API_KEY");
    expect(fallback.models.map((model) => model.id)).toContain("claude-opus-4-8");
    expect(fallback.models.map((model) => model.id)).toContain("claude-opus-4-6");
  });

  it("canonicalizes stale OpenCode Zen base URLs", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const normalizedConfig = requireRecord(
      provider.normalizeConfig?.({
        provider: "opencode",
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://opencode.ai/zen/",
          models: [],
        },
      } as never),
      "normalized config",
    );
    expect(normalizedConfig.baseUrl).toBe("https://opencode.ai/zen/v1");

    const normalizedModel = requireRecord(
      provider.normalizeResolvedModel?.({
        provider: "opencode",
        model: {
          provider: "opencode",
          id: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          api: "openai-completions",
          baseUrl: "https://opencode.ai/zen/",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 65_536,
        },
      } as never),
      "normalized model",
    );
    expect(normalizedModel.baseUrl).toBe("https://opencode.ai/zen/v1");

    expect(
      provider.normalizeTransport?.({
        provider: "opencode",
        api: "openai-completions",
        baseUrl: "https://opencode.ai/zen",
      } as never),
    ).toEqual({
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/v1",
    });
  });

  it("exposes Anthropic thinking levels for proxied Claude models", async () => {
    const { providers } = await registerProviderPlugin({
      plugin,
      id: "opencode",
      name: "OpenCode Zen Provider",
    });
    const provider = requireRegisteredProvider(providers, "opencode");
    const resolveThinkingProfile = provider.resolveThinkingProfile;
    if (!resolveThinkingProfile) {
      throw new Error("Expected OpenCode provider resolveThinkingProfile");
    }

    const opus47Profile = resolveThinkingProfile({
      provider: "opencode",
      modelId: "claude-opus-4-7",
    });
    const opus47LevelIds = opus47Profile?.levels.map((level) => level.id) ?? [];
    expect(opus47Profile?.defaultLevel).toBe("off");
    expect(opus47LevelIds).toContain("xhigh");
    expect(opus47LevelIds).toContain("adaptive");
    expect(opus47LevelIds).toContain("max");
    const opus46Profile = resolveThinkingProfile({
      provider: "opencode",
      modelId: "claude-opus-4.6",
    });
    const opus46LevelIds = opus46Profile?.levels.map((level) => level.id) ?? [];
    expect(opus46Profile?.defaultLevel).toBe("adaptive");
    expect(opus46LevelIds).toContain("adaptive");
    expect(opus46LevelIds).not.toContain("xhigh");
    expect(opus46LevelIds).not.toContain("max");
    const sonnet46Profile = resolveThinkingProfile({
      provider: "opencode",
      modelId: "claude-sonnet-4-6",
    });
    const sonnet46LevelIds = sonnet46Profile?.levels.map((level) => level.id) ?? [];
    expect(sonnet46Profile?.defaultLevel).toBe("adaptive");
    expect(sonnet46LevelIds).toContain("adaptive");
    expect(sonnet46LevelIds).not.toContain("xhigh");
    expect(sonnet46LevelIds).not.toContain("max");
  });
});

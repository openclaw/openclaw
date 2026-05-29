import {
  loadPluginManifestRegistry,
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { expectPassthroughReplayPolicy } from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("opencode provider plugin", () => {
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

  it("resolves deepseek-v4-flash-free through resolveDynamicModel", async () => {
    const { providers } = await registerProviderPlugin({
      plugin,
      id: "opencode",
      name: "OpenCode Zen Provider",
    });
    const provider = requireRegisteredProvider(providers, "opencode");
    const resolveDynamicModel = provider.resolveDynamicModel;
    if (!resolveDynamicModel) {
      throw new Error("Expected OpenCode provider resolveDynamicModel");
    }

    const model = resolveDynamicModel({
      provider: "opencode",
      modelId: "deepseek-v4-flash-free",
    });
    expect(model).toBeDefined();
    expect(model!.id).toBe("deepseek-v4-flash-free");
    expect(model!.api).toBe("openai-completions");
    expect(model!.reasoning).toBe(true);
    expect(model!.input).toContain("text");
    expect(model!.contextWindow).toBe(65_536);
    expect(model!.maxTokens).toBe(8_192);
    expect(model!.cost?.input).toBe(0);
    expect(model!.cost?.output).toBe(0);
  });

  it("resolves claude-opus-4-6 through resolveDynamicModel", async () => {
    const { providers } = await registerProviderPlugin({
      plugin,
      id: "opencode",
      name: "OpenCode Zen Provider",
    });
    const provider = requireRegisteredProvider(providers, "opencode");
    const resolveDynamicModel = provider.resolveDynamicModel;
    if (!resolveDynamicModel) {
      throw new Error("Expected OpenCode provider resolveDynamicModel");
    }

    const model = resolveDynamicModel({
      provider: "opencode",
      modelId: "claude-opus-4-6",
    });
    expect(model).toBeDefined();
    expect(model!.id).toBe("claude-opus-4-6");
    expect(model!.api).toBe("anthropic-messages");
    expect(model!.reasoning).toBe(true);
    expect(model!.input).toContain("text");
    expect(model!.input).toContain("image");
    expect(model!.contextWindow).toBe(1_000_000);
    expect(model!.maxTokens).toBe(128_000);
  });

  it("returns undefined for unknown models via resolveDynamicModel", async () => {
    const { providers } = await registerProviderPlugin({
      plugin,
      id: "opencode",
      name: "OpenCode Zen Provider",
    });
    const provider = requireRegisteredProvider(providers, "opencode");
    const resolveDynamicModel = provider.resolveDynamicModel;
    if (!resolveDynamicModel) {
      throw new Error("Expected OpenCode provider resolveDynamicModel");
    }

    const model = resolveDynamicModel({
      provider: "opencode",
      modelId: "nonexistent-model-xyz",
    });
    expect(model).toBeUndefined();
  });

  it("returns catalog entries via augmentModelCatalog", async () => {
    const { providers } = await registerProviderPlugin({
      plugin,
      id: "opencode",
      name: "OpenCode Zen Provider",
    });
    const provider = requireRegisteredProvider(providers, "opencode");
    const augmentModelCatalog = provider.augmentModelCatalog;
    if (!augmentModelCatalog) {
      throw new Error("Expected OpenCode provider augmentModelCatalog");
    }

    const entries = augmentModelCatalog({
      provider: "opencode",
    });
    expect(entries).toBeDefined();
    expect(entries!.length).toBeGreaterThan(0);

    const deepseek = entries!.find((e) => e.id === "deepseek-v4-flash-free");
    expect(deepseek).toBeDefined();
    expect(deepseek!.reasoning).toBe(true);
    expect(deepseek!.input).toContain("text");
    expect(deepseek!.contextWindow).toBe(65_536);

    const claude = entries!.find((e) => e.id === "claude-opus-4-6");
    expect(claude).toBeDefined();
    expect(claude!.reasoning).toBe(true);
  });

  it("proves runtimeAugment is active in the real manifest registry", () => {
    const registry = loadPluginManifestRegistry({});
    const opencodePlugin = registry.plugins.find(
      (p) => p.origin === "bundled" && p.id === "opencode",
    );
    expect(opencodePlugin).toBeDefined();
    expect(opencodePlugin?.modelCatalog?.runtimeAugment).toBe(true);
  });
});

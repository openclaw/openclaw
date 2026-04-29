import {
  createCapturedPluginRegistration,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import deepinfraPlugin from "./index.js";
import { DEEPINFRA_MODEL_CATALOG, resetDeepInfraModelCacheForTest } from "./provider-models.js";

function buildSyntheticDeepInfraEntries(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    provider: "deepinfra",
    id: `synthetic/model-${index}`,
    name: `synthetic/model-${index}`,
  }));
}

describe("deepinfra augmentModelCatalog", () => {
  it("returns the discovered (static under VITEST) catalog when nothing is configured", async () => {
    resetDeepInfraModelCacheForTest();
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);

    const entries = (await provider.augmentModelCatalog?.({ entries: [] } as never)) ?? [];

    expect(entries.map((entry) => entry.id)).toEqual(
      DEEPINFRA_MODEL_CATALOG.map((model) => model.id),
    );
    for (const entry of entries) {
      expect(entry.provider).toBe("deepinfra");
    }
  });

  it("preserves configured entries and appends discovered entries that are not already configured", async () => {
    resetDeepInfraModelCacheForTest();
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);

    const entries =
      (await provider.augmentModelCatalog?.({
        entries: [],
        config: {
          models: {
            providers: {
              deepinfra: {
                models: [
                  {
                    id: "zai-org/GLM-5.1",
                    name: "GLM-5.1 custom",
                    input: ["text"],
                    reasoning: true,
                    contextWindow: 202752,
                  },
                ],
              },
            },
          },
        },
      } as never)) ?? [];

    const glmEntry = entries.find((entry) => entry.id === "zai-org/GLM-5.1");
    expect(glmEntry?.name).toBe("GLM-5.1 custom");
    expect(entries.filter((entry) => entry.id === "zai-org/GLM-5.1")).toHaveLength(1);
    expect(entries.length).toBe(DEEPINFRA_MODEL_CATALOG.length);
  });

  it("skips live discovery and returns only configured entries when ctx.entries already has more DeepInfra rows than the static catalog", async () => {
    resetDeepInfraModelCacheForTest();
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);

    const seededDeepInfraCount = DEEPINFRA_MODEL_CATALOG.length + 5;
    const entries =
      (await provider.augmentModelCatalog?.({
        entries: [
          ...buildSyntheticDeepInfraEntries(seededDeepInfraCount),
          { provider: "openai", id: "noise", name: "noise" },
        ],
        config: {
          models: {
            providers: {
              deepinfra: {
                models: [
                  {
                    id: "zai-org/GLM-5.1",
                    name: "configured override",
                    input: ["text"],
                    reasoning: true,
                    contextWindow: 202752,
                  },
                ],
              },
            },
          },
        },
      } as never)) ?? [];

    expect(entries).toEqual([
      {
        provider: "deepinfra",
        id: "zai-org/GLM-5.1",
        name: "configured override",
        input: ["text"],
        reasoning: true,
        contextWindow: 202752,
      },
    ]);
  });

  it("still fetches when ctx.entries has exactly the static catalog length (static-fallback case)", async () => {
    resetDeepInfraModelCacheForTest();
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);

    const entries =
      (await provider.augmentModelCatalog?.({
        entries: buildSyntheticDeepInfraEntries(DEEPINFRA_MODEL_CATALOG.length),
      } as never)) ?? [];

    expect(entries.map((entry) => entry.id)).toEqual(
      DEEPINFRA_MODEL_CATALOG.map((model) => model.id),
    );
  });
});

describe("deepinfra capability registration", () => {
  it("registers all DeepInfra-backed OpenClaw provider surfaces", () => {
    const captured = createCapturedPluginRegistration();
    deepinfraPlugin.register(captured.api);

    expect(captured.providers.map((provider) => provider.id)).toEqual(["deepinfra"]);
    expect(captured.imageGenerationProviders.map((provider) => provider.id)).toEqual(["deepinfra"]);
    expect(captured.mediaUnderstandingProviders.map((provider) => provider.id)).toEqual([
      "deepinfra",
    ]);
    expect(captured.memoryEmbeddingProviders.map((provider) => provider.id)).toEqual(["deepinfra"]);
    expect(captured.speechProviders.map((provider) => provider.id)).toEqual(["deepinfra"]);
    expect(captured.videoGenerationProviders.map((provider) => provider.id)).toEqual(["deepinfra"]);
  });
});

describe("deepinfra isCacheTtlEligible", () => {
  it("returns true for anthropic/* proxied models", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "anthropic/claude-4-sonnet",
      }),
    ).toBe(true);
  });

  // Locked to case-insensitive to stay consistent with the shared proxy cache
  // wrapper, which lowercases the modelId before the "anthropic/" prefix check.
  it("returns true regardless of modelId case", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "Anthropic/Claude-4-Sonnet",
      }),
    ).toBe(true);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "ANTHROPIC/claude-4-sonnet",
      }),
    ).toBe(true);
  });

  it("returns false for non-anthropic models", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
      }),
    ).toBe(false);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "zai-org/GLM-5.1",
      }),
    ).toBe(false);
  });
});

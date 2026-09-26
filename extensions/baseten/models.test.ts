import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import { describe, expect, it } from "vitest";
import {
  buildStaticBasetenModels,
  projectBasetenLiveModels,
  resolveBasetenDynamicModel,
} from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

describe("Baseten model catalog", () => {
  it("keeps manifest thinking controls and declared capabilities in runtime catalogs", () => {
    const declaredModels = buildManifestModelProviderConfig({
      providerId: "baseten",
      catalog: manifest.modelCatalog.providers.baseten,
    }).models;
    const runtimeModels = new Map(buildStaticBasetenModels().map((model) => [model.id, model]));
    const inkling = declaredModels.find((model) => model.id === "thinkingmachines/inkling");

    expect.soft(inkling?.compat?.supportedReasoningEfforts).toContain("max");
    for (const model of declaredModels) {
      const runtimeModel = runtimeModels.get(model.id);
      expect(runtimeModel, model.id).toBeDefined();
      for (const field of [
        "supportsReasoningEffort",
        "supportedReasoningEfforts",
        "reasoningEffortMap",
        "codeMode",
      ] as const) {
        expect
          .soft(runtimeModel?.compat?.[field], `${model.id} ${field}`)
          .toEqual(model.compat?.[field]);
      }
    }
  });

  it("projects authenticated live rows while retaining curated capability metadata", () => {
    const models = projectBasetenLiveModels([
      {
        id: "thinkingmachines/inkling",
        object: "model",
        name: "Inkling live",
        context_length: 1_048_576,
        max_completion_tokens: 32_768,
        pricing: {
          prompt: "0.0000011",
          completion: "0.0000042",
          input_cache_read: "0.00000018",
        },
        supported_features: ["vision", "reasoning", "reasoning_effort"],
      },
      {
        id: "future/model",
        object: "model",
        context_length: 64_000,
        max_completion_tokens: 4_000,
        pricing: { prompt: 0.0000002, completion: 0.0000008, input_cache_read: 0.00000004 },
        supported_features: ["vision", "reasoning_effort"],
      },
      { id: "future/model", object: "model" },
      { id: "ignored", object: "not-a-model" },
    ]);

    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: "thinkingmachines/inkling",
      name: "Inkling live",
      contextWindow: 1_048_576,
      maxTokens: 32_768,
      cost: { input: 1.1, output: 4.2, cacheRead: 0.18, cacheWrite: 0 },
      compat: { supportsReasoningEffort: true, maxTokensField: "max_tokens" },
    });
    expect(models[1]).toMatchObject({
      id: "future/model",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 64_000,
      maxTokens: 4_000,
      cost: { input: 0.2, output: 0.8, cacheRead: 0.04, cacheWrite: 0 },
      compat: {
        supportsReasoningEffort: true,
        supportsTools: true,
        supportsStrictMode: true,
      },
    });
  });

  it("uses live capability metadata when present and curated metadata when absent", () => {
    const liveCapabilities = projectBasetenLiveModels([
      {
        id: "thinkingmachines/inkling",
        object: "model",
        supported_features: [],
      },
    ])[0];
    const curatedCapabilities = projectBasetenLiveModels([
      {
        id: "thinkingmachines/inkling",
        object: "model",
      },
    ])[0];

    expect(liveCapabilities).toMatchObject({ reasoning: false, input: ["text"] });
    expect(liveCapabilities?.compat?.supportsReasoningEffort).toBeUndefined();
    expect(liveCapabilities?.compat?.supportedReasoningEfforts).toBeUndefined();
    expect(liveCapabilities?.compat?.reasoningEffortMap).toBeUndefined();
    expect(curatedCapabilities).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      compat: { supportsReasoningEffort: true },
    });
  });

  it("resolves future model ids without shadowing bundled rows", () => {
    expect(resolveBasetenDynamicModel("thinkingmachines/inkling")).toBeUndefined();
    expect(resolveBasetenDynamicModel("future/model")).toMatchObject({
      id: "future/model",
      provider: "baseten",
      api: "openai-completions",
      baseUrl: "https://inference.baseten.co/v1",
      compat: { supportsTools: true, maxTokensField: "max_tokens" },
    });
  });
});

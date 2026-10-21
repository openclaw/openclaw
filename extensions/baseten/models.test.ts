import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import { describe, expect, it } from "vitest";
import {
  buildStaticBasetenModels,
  projectBasetenLiveModels,
  resolveBasetenDynamicModel,
} from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const FLASH = "deepseek-ai/DeepSeek-V4.1-Flash";
const sparseFeatures = ["tools", "reasoning", "json_mode", "structured_outputs"];
const liveRow = (id: string, fields: object = {}) => ({ id, object: "model", ...fields });

describe("Baseten model catalog", () => {
  it("keeps manifest thinking controls and declared capabilities in runtime catalogs", () => {
    const declaredModels = buildManifestModelProviderConfig({
      providerId: "baseten",
      catalog: manifest.modelCatalog.providers.baseten,
    }).models;
    const runtimeModels = new Map(buildStaticBasetenModels().map((model) => [model.id, model]));
    const defaultModel = declaredModels.find((model) => model.id === FLASH);

    expect.soft(defaultModel?.compat?.supportedReasoningEfforts).toContain("max");
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
          .toEqual(
            model.compat?.[field] ?? (field === "supportsReasoningEffort" ? false : undefined),
          );
      }
    }
  });

  it("projects authenticated live rows while retaining curated capability metadata", () => {
    const models = projectBasetenLiveModels([
      liveRow("thinkingmachines/inkling", {
        name: "Inkling live",
        context_length: 1_048_576,
        max_completion_tokens: 32_768,
        pricing: {
          prompt: "0.0000011",
          completion: "0.0000042",
          input_cache_read: "0.00000018",
        },
        supported_features: ["vision", "reasoning", "reasoning_effort"],
      }),
      liveRow("future/model", {
        context_length: 64_000,
        max_completion_tokens: 4_000,
        pricing: { prompt: 0.0000002, completion: 0.0000008, input_cache_read: 0.00000004 },
        supported_features: ["vision", "reasoning_effort"],
      }),
      liveRow("future/model"),
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
    const [live] = projectBasetenLiveModels([liveRow(FLASH, { supported_features: [] })]);
    const [curated] = projectBasetenLiveModels([liveRow(FLASH)]);

    expect(live).toMatchObject({ reasoning: false, input: ["text"] });
    expect(live?.compat?.supportsReasoningEffort).toBe(false);
    expect(live?.compat?.supportedReasoningEfforts).toBeUndefined();
    expect(live?.compat?.reasoningEffortMap).toBeUndefined();
    expect(curated).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      compat: { supportsReasoningEffort: true },
    });
  });

  it("resolves future model ids without shadowing bundled rows", () => {
    expect(resolveBasetenDynamicModel(FLASH)).toBeUndefined();
    expect(resolveBasetenDynamicModel("thinkingmachines/inkling")?.id).toBe(
      "thinkingmachines/inkling",
    );
    expect(resolveBasetenDynamicModel("future/model")).toMatchObject({
      id: "future/model",
      provider: "baseten",
      api: "openai-completions",
      baseUrl: "https://inference.baseten.co/v1",
      compat: { supportsTools: true, supportsReasoningEffort: false, maxTokensField: "max_tokens" },
    });
  });

  it.each<[string, string[]]>([
    ["future/model", sparseFeatures],
    [`${FLASH}-custom`, sparseFeatures],
    ["zai-org/GLM-5.2", ["tools", "reasoning"]],
    ["deepseek-ai/DeepSeek-V4-Pro-0813", []],
    [FLASH, ["tools"]],
  ])("does not borrow documented Flash capabilities for %s with %j", (id, features) => {
    const [model] = projectBasetenLiveModels([liveRow(id, { supported_features: features })]);
    expect(model).toMatchObject({ reasoning: features.includes("reasoning"), input: ["text"] });
    expect(model?.compat?.supportsReasoningEffort).toBe(false);
    expect(model?.compat?.supportedReasoningEfforts).toBeUndefined();
  });
});

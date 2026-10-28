import { expect, it } from "vitest";
import * as catalog from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const FLASH = "deepseek-ai/DeepSeek-V4.1-Flash";
const liveRow = (id: string, fields: object = {}) => ({ id, object: "model", ...fields });

it("projects future live rows, rejecting duplicates and non-models", () => {
  const models = catalog.projectBasetenLiveModels([
    liveRow("future/model", {
      name: "Future live",
      context_length: 64_000,
      max_completion_tokens: 4_000,
      pricing: { prompt: 0.0000002, completion: 0.0000008, input_cache_read: 0.00000004 },
      supported_features: ["vision", "reasoning_effort"],
    }),
    liveRow("future/model"),
    { id: "ignored", object: "not-a-model" },
  ]);

  expect(models).toMatchObject([
    {
      id: "future/model",
      name: "Future live",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 64_000,
      maxTokens: 4_000,
      cost: { input: 0.2, output: 0.8, cacheRead: 0.04, cacheWrite: 0 },
      compat: { supportsReasoningEffort: true, supportsTools: true, supportsStrictMode: true },
    },
  ]);
});

it("uses curated capability metadata when live features are absent", () => {
  const [curated] = catalog.projectBasetenLiveModels([liveRow(FLASH)]);
  expect(curated).toMatchObject({
    reasoning: true,
    input: ["text", "image"],
    compat: {
      supportsReasoningEffort: true,
      supportedReasoningEfforts: expect.arrayContaining(["max"]),
    },
  });
});

it("resolves future model ids without shadowing bundled rows", () => {
  expect(catalog.resolveBasetenDynamicModel(FLASH)).toBeUndefined();
  expect(catalog.resolveBasetenDynamicModel("future/model")).toMatchObject({
    id: "future/model",
    provider: "baseten",
    api: "openai-completions",
    baseUrl: "https://inference.baseten.co/v1",
    compat: { supportsTools: true, supportsReasoningEffort: false, maxTokensField: "max_tokens" },
  });
});

it.each<[string, string[]]>([
  [`${FLASH}-custom`, ["tools", "reasoning", "json_mode", "structured_outputs"]],
  ["zai-org/GLM-5.2", ["tools", "reasoning"]],
  ["deepseek-ai/DeepSeek-V4-Pro-0813", []],
  [FLASH, []],
])("does not borrow documented Flash capabilities for %s with %j", (id, features) => {
  const [row] = catalog.projectBasetenLiveModels([liveRow(id, { supported_features: features })]);
  expect(row).toMatchObject({
    reasoning: features.includes("reasoning"),
    input: ["text"],
    compat: { supportsReasoningEffort: false },
  });
  expect(row?.compat?.supportedReasoningEfforts).toBeUndefined();
  expect(row?.compat?.reasoningEffortMap).toBeUndefined();
});

it("keeps System One models out of every conversational discovery path", () => {
  const ids = [
    "decision-models/baseten-elephant-9b-latest",
    "decision-models/baseten-mammoth-27b-latest",
  ];
  expect(catalog.buildStaticBasetenModels().some((model) => ids.includes(model.id))).toBe(false);
  expect(catalog.projectBasetenLiveModels(ids.map((id) => liveRow(id)))).toEqual([]);
  for (const id of ids) {
    expect(catalog.resolveBasetenDynamicModel(id)).toBeUndefined();
    const row = manifest.modelCatalog.providers.baseten.models.find((model) => model.id === id);
    expect(row?.inference).toMatchObject({
      chat: false,
      decision: { protocol: "baseten-systemone" },
    });
  }
});

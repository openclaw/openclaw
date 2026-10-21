import { clampThinkingLevel, type Model } from "openclaw/plugin-sdk/llm";
import { parseModelRef } from "openclaw/plugin-sdk/provider-model-shared";
import { expect, it } from "vitest";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildKimiCodingProvider, normalizeKimiCodingModelId } from "./provider-catalog.js";
import { KIMI_K3_MODEL_IDS } from "./provider-policy-api.js";

const catalog = manifest.modelCatalog.providers.kimi;

it.each(catalog.models.filter((model) => ["k3", "k3-256k"].includes(model.id)))(
  "keeps documented off thinking selectable for $id",
  (row) => {
    const model: Model<"anthropic-messages"> = {
      ...row,
      api: "anthropic-messages",
      compat: undefined,
      provider: "kimi",
      baseUrl: catalog.baseUrl,
      input: ["text", "image"],
    };
    expect(clampThinkingLevel(model, "off")).toBe("off");
  },
);

it("builds the bundled Kimi coding defaults", () => {
  const provider = buildKimiCodingProvider();

  expect(provider).toMatchObject({
    api: "anthropic-messages",
    baseUrl: "https://api.kimi.com/coding/",
  });
  expect(provider.headers).toEqual({ "User-Agent": "claude-code/0.1.0" });
  const k3Contract = {
    reasoning: true,
    thinkingLevelMap: {
      minimal: "low",
      low: "low",
      medium: "high",
      high: "high",
      xhigh: "max",
      max: "max",
    },
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
    maxTokens: 131_072,
    compat: { codeMode: "preferred" },
  };
  expect(provider.models).toMatchObject([
    { ...k3Contract, id: "k3", name: "Kimi K3", contextWindow: 1_048_576 },
    { ...k3Contract, id: "k3-256k", name: "Kimi K3 (256k)", contextWindow: 262_144 },
    { id: "kimi-for-coding" },
    {
      id: "kimi-for-coding-highspeed",
      name: "Kimi K2.7 Code HighSpeed",
      reasoning: true,
      contextWindow: 262_144,
      maxTokens: 32_768,
    },
  ]);
  expect(provider.models.slice(2).map((model) => model.compat?.codeMode)).toEqual([
    undefined,
    undefined,
  ]);
});

it("covers every K3 catalog row with the K3 thinking policy", () => {
  const thinkingRows = buildKimiCodingProvider()
    .models.filter((model) => model.thinkingLevelMap)
    .map((model) => model.id);

  expect(KIMI_K3_MODEL_IDS).toEqual(expect.arrayContaining(thinkingRows));
  expect(KIMI_K3_MODEL_IDS).toContain("kimi-k3");
});

it.each([
  ["kimi-code", "kimi-for-coding"],
  ["k2p5", "kimi-for-coding"],
  ["kimi-for-coding", "kimi-for-coding"],
  ["k3[1m]", "k3"],
])("normalizes %s to %s through the helper and static manifest", (input, expected) => {
  const options = { manifestPlugins: [manifest], allowPluginNormalization: false };
  expect(normalizeKimiCodingModelId(input)).toBe(expected);
  expect(parseModelRef(`kimi/${input}`, "kimi", options)).toEqual({
    provider: "kimi",
    model: expected,
  });
});

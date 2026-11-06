import { clampThinkingLevel, type Model } from "openclaw/plugin-sdk/llm";
import { parseModelRef } from "openclaw/plugin-sdk/provider-model-shared";
import { expect, it } from "vitest";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildKimiCodingProvider, normalizeKimiCodingModelId } from "./provider-catalog.js";
import { isKimiK3ModelId } from "./provider-policy-api.js";

const catalog = manifest.modelCatalog.providers.kimi;

it.each(catalog.models.filter((model) => ["k3", "k3-256k"].includes(model.id)))(
  "keeps documented off thinking selectable for $id",
  (row) => {
    const model: Model<"anthropic-messages"> = {
      ...row,
      api: "anthropic-messages",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
  for (const model of provider.models.slice(0, 2)) {
    expect(model).toMatchObject({
      thinkingLevelMap: {
        minimal: "low",
        low: "low",
        medium: "high",
        high: "high",
        xhigh: "max",
        max: "max",
      },
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
      compat: { codeMode: "preferred" },
    });
  }
  expect(provider.models.map((m) => [m.id, m.name, m.contextWindow, m.maxTokens])).toEqual([
    ["k3", "Kimi K3", 1_048_576, 131_072],
    ["k3-256k", "Kimi K3 (256k)", 262_144, 131_072],
    ["k3.1-pro", "Kimi K3.1 Pro", 1_048_576, 131_072],
    ["k3.1-pro-highspeed", "Kimi K3.1 Pro Highspeed", 1_048_576, 131_072],
    ["kimi-for-coding", "Kimi Code", 262_144, 32_768],
    ["kimi-for-coding-highspeed", "Kimi K2.7 Code HighSpeed", 262_144, 32_768],
  ]);
  expect(provider.models.every((m) => m.reasoning)).toBe(true);
  expect(provider.models.slice(2).map((model) => model.compat?.codeMode)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

it("keeps the K3 policy for IDs without a Kimi Code row", () => {
  expect(["kimi-k3", "k3[1m]"].filter((id) => !isKimiK3ModelId(id))).toEqual([]);
});

it.each([
  ["kimi-code", "kimi-for-coding"],
  ["k2p5", "kimi-for-coding"],
  ["kimi-for-coding", "kimi-for-coding"],
  ["k3[1m]", "k3"],
])("normalizes %s to %s through the helper and static manifest", (input, model) => {
  const options = { manifestPlugins: [manifest], allowPluginNormalization: false };
  expect(normalizeKimiCodingModelId(input)).toBe(model);
  expect(parseModelRef(`kimi/${input}`, "kimi", options)).toEqual({ provider: "kimi", model });
});

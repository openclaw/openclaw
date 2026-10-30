import { expect, it } from "vitest";
import { resolveThinkingProfile } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildThinkingCatalog, resolveThinkingDefaultCore } from "./model-thinking-default-core.js";
import { resolveThinkingDefaultWithRuntimeCatalogCore } from "./model-thinking-default.js";

function savedRow(id: string) {
  return {
    id,
    name: id,
    reasoning: true,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 32_000,
  };
}

// Callers such as voice responses pass no catalog; row-owned thinking profiles must still apply.
it.each([
  ["deepseek", "deepseek-v4-pro", "high"],
  ["moonshot", "kimi-k3", "max"],
  ["moonshot", "kimi-k2.7-code", "low"],
  ["kimi", "k3", "high"],
] as const)("resolves the %s/%s default without a caller catalog", (provider, model, level) => {
  expect(resolveThinkingDefaultCore({ cfg: {}, provider, model })).toBe(level);
});

it("fills thinking facts a saved configured row omits, keeping its explicit values", () => {
  const cfg: OpenClawConfig = {
    models: {
      providers: {
        deepseek: { baseUrl: "https://api.deepseek.com", models: [savedRow("deepseek-v4-pro")] },
      },
    },
  };
  expect(resolveThinkingDefaultCore({ cfg, provider: "deepseek", model: "deepseek-v4-pro" })).toBe(
    "high",
  );
  const overridden: OpenClawConfig = {
    models: {
      providers: {
        deepseek: {
          baseUrl: "https://api.deepseek.com",
          models: [{ ...savedRow("deepseek-v4-pro"), compat: { defaultThinkingLevel: "low" } }],
        },
      },
    },
  };
  expect(
    resolveThinkingDefaultCore({ cfg: overridden, provider: "deepseek", model: "deepseek-v4-pro" }),
  ).toBe("low");
});

it("keeps the Mistral reasoning profile for a configured proxy row without a map", () => {
  const cfg: OpenClawConfig = {
    models: {
      providers: {
        mistral: {
          api: "openai-completions",
          baseUrl: "https://proxy.example/v1",
          models: [savedRow("mistral-small-latest")],
        },
      },
    },
  };
  const params = { provider: "mistral", model: "mistral-small-latest" };
  expect(resolveThinkingDefaultCore({ cfg, ...params })).toBe("off");
  const profile = resolveThinkingProfile({
    ...params,
    catalog: buildThinkingCatalog({ cfg, ...params }),
  });
  expect(profile.levels.map(({ id }) => id)).toEqual(
    expect.arrayContaining(["adaptive", "xhigh", "max"]),
  );
});

it("lets the selected runtime row win over the bundled fallback", async () => {
  const loadRuntimeCatalog = async () => [
    { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: false },
  ];
  await expect(
    resolveThinkingDefaultWithRuntimeCatalogCore({
      cfg: {},
      provider: "deepseek",
      model: "deepseek-v4-pro",
      loadRuntimeCatalog,
    }),
  ).resolves.toBe("off");
});

// A configured partial map keeps the bundled row's other keys, including the nulls.
it.each([
  [
    "mistral",
    "mistral-small-latest",
    { max: "high" },
    ["off", "minimal", "low", "medium", "adaptive", "high", "xhigh", "max"],
    "off",
  ],
  ["moonshot", "kimi-k3", { max: "max" }, ["max"], "max"],
] as const)(
  "merges a partial %s/%s map with the bundled row",
  (provider, model, map, levels, level) => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          [provider]: {
            baseUrl: "https://example.test/v1",
            models: [{ ...savedRow(model), thinkingLevelMap: map }],
          },
        },
      },
    };
    const profile = resolveThinkingProfile({
      provider,
      model,
      catalog: buildThinkingCatalog({ cfg, provider, model }),
    });
    expect(profile.levels.map(({ id }) => id).filter((id) => id !== "ultra")).toEqual(levels);
    expect(resolveThinkingDefaultCore({ cfg, provider, model })).toBe(level);
  },
);

it("keeps Moonshot K3 max-only for a configured map written for the earlier hook", () => {
  // The previous docs example; the provider hook used to force max regardless.
  const thinkingLevelMap = {
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: "max",
    max: "max",
  };
  const cfg: OpenClawConfig = {
    models: {
      providers: {
        moonshot: {
          baseUrl: "https://api.moonshot.ai/v1",
          models: [{ ...savedRow("kimi-k3"), thinkingLevelMap }],
        },
      },
    },
  };
  const params = { provider: "moonshot", model: "kimi-k3" };
  const profile = resolveThinkingProfile({
    ...params,
    catalog: buildThinkingCatalog({ cfg, ...params }),
  });
  expect(profile.levels.map(({ id }) => id).filter((id) => id !== "ultra")).toEqual(["max"]);
});

it("lets a configured effort list replace the profile a bundled Grok row owns", () => {
  const cfg: OpenClawConfig = {
    models: {
      providers: {
        xai: {
          baseUrl: "https://api.x.ai/v1",
          models: [
            { ...savedRow("grok-4.3"), compat: { supportedReasoningEfforts: ["none", "high"] } },
          ],
        },
      },
    },
  };
  const params = { provider: "xai", model: "grok-4.3" };
  const profile = resolveThinkingProfile({
    ...params,
    catalog: buildThinkingCatalog({ cfg, ...params }),
  });
  expect(profile.levels.map(({ id }) => id).filter((id) => id !== "ultra")).toEqual([
    "off",
    "high",
  ]);
  expect(profile.defaultLevel).toBe("high");
});

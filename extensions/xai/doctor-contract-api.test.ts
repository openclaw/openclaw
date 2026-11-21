import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readMigrationConfigPath } from "openclaw/plugin-sdk/migration";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";
import { xaiPluginConfig as pluginConfig } from "./plugin-config.test-support.js";

function mediaConfig(models: unknown[]): OpenClawConfig {
  return { tools: { media: { models } } } as OpenClawConfig;
}

function imageEntry(overrides: Record<string, unknown> = {}) {
  return { provider: "xai", model: "grok-4-fast", capabilities: ["image"], ...overrides };
}

function migrate(config: OpenClawConfig, count: number) {
  const original = structuredClone(config);
  expect(
    legacyConfigRules.filter((rule) =>
      rule.match(readMigrationConfigPath(config, rule.path.map(String))),
    ),
  ).toHaveLength(count);
  const result = normalizeCompatibilityConfig({ cfg: config });
  expect(result.changes).toHaveLength(count);
  expect(result.config).not.toBe(config);
  expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
    config: result.config,
    changes: [],
  });
  expect(config).toEqual(original);
  return result;
}

describe("xAI doctor contract", () => {
  it("detects and migrates retired server-tool defaults without changing other settings", () => {
    const builtin = {
      id: "grok-4-1-fast",
      name: "Grok 4.1 Fast",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0.2, output: 0.5, cacheRead: 0.05, cacheWrite: 0 },
      contextWindow: 2_000_000,
      maxTokens: 30_000,
    };
    const models = [
      builtin,
      { ...builtin, name: "Custom Grok 4.1 Fast" },
      { id: "grok-4.20-beta-latest-reasoning", name: "moving alias" },
      { id: "custom-model", name: "custom" },
    ];
    const config = {
      ...pluginConfig({
        webSearch: { model: "grok-4-1-fast", timeoutSeconds: 60 },
        xSearch: { model: "grok-4-1-fast-non-reasoning", inlineCitations: true },
        codeExecution: { model: "grok-code-fast-1", maxTurns: 2 },
      }),
      tools: {
        web: {
          search: { grok: { model: "grok-4-0709", baseUrl: "https://api.x.ai/v1" } },
          x_search: { model: "grok-3", enabled: true },
        },
      },
      models: {
        providers: { xai: { baseUrl: "https://api.x.ai/v1", api: "openai-responses", models } },
      },
    } as OpenClawConfig;

    const result = migrate(config, 4);
    expect(result.config.plugins?.entries?.xai?.config).toEqual({
      webSearch: { model: "grok-4.3", timeoutSeconds: 60 },
      xSearch: { model: "grok-4.3", inlineCitations: true },
      codeExecution: { model: "grok-build-0.1", maxTurns: 2 },
    });
    expect(result.config.tools?.web).toEqual(config.tools?.web);
    expect(result.config.models?.providers?.xai?.models).toEqual(models.slice(1));
  });

  it("leaves active aliases and intentional cross-mode choices unchanged", () => {
    const config = pluginConfig({
      webSearch: { model: "grok-4.20-beta-latest-reasoning" },
      xSearch: { model: "grok-4-1-fast" },
      codeExecution: { model: "grok-4-fast-non-reasoning" },
    });

    expect(normalizeCompatibilityConfig({ cfg: config })).toEqual({ config, changes: [] });
  });

  it("adds the long-context tier to OAuth rows saved at the catalog's flat rates", () => {
    // The shape OAuth sign-in saved before the catalog carried tiers.
    const saved = (
      id: string,
      cost: ModelDefinitionConfig["cost"],
      baseUrl = "https://cli-chat-proxy.grok.com/v1",
    ): ModelDefinitionConfig => ({
      id,
      name: id,
      api: "openai-responses",
      baseUrl,
      reasoning: true,
      input: ["text"],
      cost,
      contextWindow: 256_000,
      maxTokens: 64_000,
      compat: {},
    });
    const flat = { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 };
    const unchanged = [
      saved("grok-4.5", { ...flat, input: 1 }),
      saved("grok-4.5", { ...flat, tieredPricing: [] }),
      saved("grok-4.7-build-fast", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      // A custom route owns its billing, even at the catalog's flat rates.
      saved("grok-4.5", flat, "https://proxy.example.test/v1"),
    ];
    const config: OpenClawConfig = {
      models: {
        providers: { xai: { baseUrl: "", models: [saved("grok-4.5", flat), ...unchanged] } },
      },
    };
    const result = migrate(config, 1);
    const [repaired, ...rest] = result.config.models?.providers?.xai?.models ?? [];
    expect(repaired?.cost.tieredPricing?.map((tier) => [tier.range, tier.input])).toEqual([
      [[0, 200_000], 2],
      [[200_000], 4],
    ]);
    expect(rest).toEqual(unchanged);

    const { baseUrl: _route, ...unrouted } = saved("grok-4.5", flat);
    const customProvider: OpenClawConfig = {
      models: {
        providers: { xai: { baseUrl: "https://proxy.example.test/v1", models: [unrouted] } },
      },
    };
    expect(normalizeCompatibilityConfig({ cfg: customProvider })).toEqual({
      config: customProvider,
      changes: [],
    });
  });

  it("repairs a saved OAuth grok-build row through the discovery pricing alias", () => {
    // OAuth discovery prices grok-build as grok-build-0.1 and persists id grok-build.
    const flat = { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 };
    const row: ModelDefinitionConfig = {
      id: "grok-build",
      name: "grok-build",
      api: "openai-responses",
      baseUrl: "https://cli-chat-proxy.grok.com/v1",
      reasoning: true,
      input: ["text"],
      cost: flat,
      contextWindow: 256_000,
      maxTokens: 64_000,
      compat: {},
    };
    const config: OpenClawConfig = {
      models: {
        providers: {
          xai: { baseUrl: "https://cli-chat-proxy.grok.com/v1", models: [row] },
        },
      },
    };
    const result = migrate(config, 1);
    const repaired = result.config.models?.providers?.xai?.models?.[0];
    expect(repaired?.id).toBe("grok-build");
    expect(repaired?.cost).toEqual({
      ...flat,
      tieredPricing: [
        { range: [0, 200_000], input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 },
        { range: [200_000], input: 2, output: 4, cacheRead: 0.4, cacheWrite: 0 },
      ],
    });
  });

  it.each([
    {
      name: "redirects retired image models",
      changed: [imageEntry(), imageEntry({ provider: "x-ai" })],
      expected: [
        imageEntry({ model: "grok-4.3" }),
        imageEntry({ provider: "x-ai", model: "grok-4.3" }),
      ],
      message: /Migrated 2 retired xAI image models/,
      unchanged: [
        imageEntry({ model: "grok-4-fast-non-reasoning" }),
        imageEntry({ model: "grok-4.3" }),
        imageEntry({ provider: "openai" }),
        { type: "cli", provider: "xai", model: "grok-4-fast", command: "vision" },
        imageEntry({ command: "vision" }),
        imageEntry({ model: "custom-vision" }),
        imageEntry({ capabilities: ["audio"] }),
        { provider: "xai", model: "grok-4-fast" },
        { provider: "xai", model: "grok-4-fast", capability: "image" },
      ],
    },
    {
      name: "removes only the obsolete STT selector",
      order: [0, 2, 3, 4, 1, 5],
      changed: [
        { provider: " xAI ", model: " GROK-STT ", language: "en", timeoutSeconds: 30 },
        { provider: "x-ai", model: "grok-stt" },
      ],
      expected: [{ provider: " xAI ", language: "en", timeoutSeconds: 30 }, { provider: "x-ai" }],
      unchanged: [
        { type: "provider", provider: "xai", model: "custom-stt" },
        { type: "provider", provider: "openai", model: "grok-stt" },
        { type: "cli", provider: "xai", model: "grok-stt", command: "whisper" },
        { provider: "xai" },
      ],
    },
  ])("$name in media entries", ({ changed, expected, unchanged, message, order }) => {
    const retained = structuredClone(unchanged);
    const arrange = (entries: unknown[]) =>
      order ? order.map((index) => entries[index]) : entries;
    const result = migrate(mediaConfig(arrange([...changed, ...unchanged])), 1);
    expect(result.config.tools?.media?.models).toEqual(arrange([...expected, ...retained]));
    if (message) {
      expect(result.changes[0]).toMatch(message);
    }
  });
});

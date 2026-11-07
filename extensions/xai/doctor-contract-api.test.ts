import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readMigrationConfigPath } from "openclaw/plugin-sdk/migration";
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

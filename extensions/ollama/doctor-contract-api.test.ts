import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";
import { createModel } from "./model.test-support.js";

const cloudModel = createModel("kimi-k2.5:cloud", "Kimi K2.5 Cloud", { contextWindow: 131072 });
const localProfile = { provider: "ollama", mode: "api_key" as const };
const otherProfile = { provider: "openai", mode: "api_key" as const };

function legacyLocalConfig(
  baseUrl = "http://127.0.0.1:11434",
  profile: (typeof localProfile & { displayName?: string }) | null = localProfile,
): OpenClawConfig {
  return {
    models: {
      providers: {
        ollama: { baseUrl, api: "ollama", apiKey: "OLLAMA_API_KEY", models: [cloudModel] },
      },
    },
    auth: {
      profiles: {
        ...(profile ? { "ollama:default": profile } : {}),
        "openai:default": otherProfile,
      },
    },
    agents: { defaults: { model: { primary: "ollama/kimi-k2.5:cloud" } } },
  };
}

function matchesLegacy(config: OpenClawConfig) {
  return legacyConfigRules[0]?.match(
    config.models?.providers?.ollama,
    config as unknown as Record<string, unknown>,
  );
}

function expectUnchanged(config: OpenClawConfig) {
  const original = structuredClone(config);
  expect(normalizeCompatibilityConfig({ cfg: config })).toEqual({ config: original, changes: [] });
  expect(config).toEqual(original);
}

describe("ollama doctor contract", () => {
  it.each([
    ["https://OLLAMA.COM:443/api", localProfile],
    ["${OLLAMA_BASE_URL}", localProfile],
    [undefined, null],
    [undefined, { ...localProfile, displayName: "Remote Ollama" }],
  ] as const)("preserves non-legacy config at %s with profile %j", (baseUrl, profile) => {
    const config = legacyLocalConfig(baseUrl, profile);
    if (baseUrl) {
      config.agents = { defaults: { model: "ollama/kimi-k2.5:cloud@ollama:default" } };
    }
    expect(matchesLegacy(config)).toBe(false);
    expectUnchanged(config);
  });

  it("migrates the pre-#123190 local marker without replacing its catalog or default", () => {
    const config = legacyLocalConfig();
    expect(matchesLegacy(config)).toBe(true);
    const original = structuredClone(config);
    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.changes).toEqual([
      "Migrated models.providers.ollama.apiKey to ollama-local and removed the obsolete ollama:default auth profile marker.",
    ]);
    expect(result.config).toEqual({
      ...original,
      models: {
        providers: { ollama: { ...original.models?.providers?.ollama, apiKey: "ollama-local" } },
      },
      auth: { profiles: { "openai:default": otherProfile } },
    });
    expect(config).toEqual(original);
    expectUnchanged(result.config);
  });
});

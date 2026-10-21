import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";
import { createModel } from "./model.test-support.js";

const cloudModel = createModel("kimi-k2.5:cloud", "Kimi K2.5 Cloud", { contextWindow: 131072 });

function legacyLocalConfig(baseUrl = "http://127.0.0.1:11434"): OpenClawConfig {
  return {
    models: {
      providers: {
        ollama: { baseUrl, api: "ollama", apiKey: "OLLAMA_API_KEY", models: [cloudModel] },
      },
    },
    auth: {
      profiles: {
        "ollama:default": { provider: "ollama", mode: "api_key" },
        "openai:default": { provider: "openai", mode: "api_key" },
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
  it.each(["https://OLLAMA.COM:443/api", "${OLLAMA_BASE_URL}"])(
    "preserves hosted auth and model refs at %s",
    (baseUrl) => {
      const config = legacyLocalConfig(baseUrl);
      config.agents = { defaults: { model: "ollama/kimi-k2.5:cloud@ollama:default" } };
      expect(matchesLegacy(config)).toBe(false);
      expectUnchanged(config);
    },
  );

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
      auth: { profiles: { "openai:default": { provider: "openai", mode: "api_key" } } },
    });
    expect(config).toEqual(original);
    expectUnchanged(result.config);
  });

  it("preserves current env-backed marker configs without the exact legacy profile", () => {
    const withoutProfile = legacyLocalConfig();
    delete withoutProfile.auth?.profiles?.["ollama:default"];
    const customizedProfile = legacyLocalConfig();
    customizedProfile.auth!.profiles!["ollama:default"] = {
      provider: "ollama",
      mode: "api_key",
      displayName: "Remote Ollama",
    };
    expectUnchanged(withoutProfile);
    expectUnchanged(customizedProfile);
  });
});

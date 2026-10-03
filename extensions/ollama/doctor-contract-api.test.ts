import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";
import { createModel } from "./model.test-support.js";

const cloudModel = createModel("kimi-k2.5:cloud", "Kimi K2.5 Cloud", { contextWindow: 131072 });

function legacyLocalConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        ollama: {
          baseUrl: "http://127.0.0.1:11434",
          api: "ollama",
          apiKey: "OLLAMA_API_KEY",
          models: [cloudModel],
        },
      },
    },
    auth: {
      profiles: {
        "ollama:default": { provider: "ollama", mode: "api_key" },
        "openai:default": { provider: "openai", mode: "api_key" },
      },
    },
    agents: { defaults: { model: { primary: "ollama/kimi-k2.5:cloud" } } },
  } as OpenClawConfig;
}

describe("ollama doctor contract", () => {
  it("migrates the pre-#123190 local marker without replacing its catalog or default", () => {
    const config = legacyLocalConfig();
    const localRule = legacyConfigRules[0];

    expect(
      localRule?.match(
        config.models?.providers?.ollama,
        config as unknown as Record<string, unknown>,
      ),
    ).toBe(true);

    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.changes).toEqual([
      "Migrated models.providers.ollama.apiKey to ollama-local and removed the obsolete ollama:default auth profile marker.",
    ]);
    expect(result.config.models?.providers?.ollama).toEqual({
      baseUrl: "http://127.0.0.1:11434",
      api: "ollama",
      apiKey: "ollama-local",
      models: [cloudModel],
    });
    expect(result.config.auth?.profiles).toEqual({
      "openai:default": { provider: "openai", mode: "api_key" },
    });
    expect(result.config.agents?.defaults?.model).toEqual({
      primary: "ollama/kimi-k2.5:cloud",
    });
    expect(config.models?.providers?.ollama?.apiKey).toBe("OLLAMA_API_KEY");
    expect(config.auth?.profiles?.["ollama:default"]).toBeDefined();
    expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
      config: result.config,
      changes: [],
    });
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

    expect(normalizeCompatibilityConfig({ cfg: withoutProfile })).toEqual({
      config: withoutProfile,
      changes: [],
    });
    expect(normalizeCompatibilityConfig({ cfg: customizedProfile })).toEqual({
      config: customizedProfile,
      changes: [],
    });
  });
});

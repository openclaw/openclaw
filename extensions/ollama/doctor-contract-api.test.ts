// Ollama tests cover doctor contract config compatibility.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

type ModelDefinition = NonNullable<
  NonNullable<OpenClawConfig["models"]>["providers"]
>[string]["models"][number];

const cloudModel: ModelDefinition = {
  id: "kimi-k2.5:cloud",
  name: "Kimi K2.5 Cloud",
  reasoning: false,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 131072,
  maxTokens: 8192,
};

function readOllamaCloudProvider(config: OpenClawConfig): Record<string, unknown> | undefined {
  return config.models?.providers?.["ollama-cloud"] as Record<string, unknown> | undefined;
}

describe("ollama doctor contract", () => {
  it("detects retired Ollama Cloud provider endpoints", () => {
    expect(legacyConfigRules[0]?.match({ baseUrl: "https://ai.ollama.com" })).toBe(true);
    expect(legacyConfigRules[0]?.match({ baseUrl: "https://ollama.com" })).toBe(false);
  });

  it("migrates retired Ollama Cloud provider baseUrl to the canonical endpoint", () => {
    const config = {
      models: {
        providers: {
          "ollama-cloud": {
            baseUrl: "https://ai.ollama.com",
            api: "ollama",
            models: [cloudModel],
          },
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.changes).toEqual([
      "Updated models.providers.ollama-cloud.baseUrl from retired https://ai.ollama.com to https://ollama.com.",
    ]);
    expect(readOllamaCloudProvider(result.config)).toEqual({
      baseUrl: "https://ollama.com",
      api: "ollama",
      models: [cloudModel],
    });
    expect(readOllamaCloudProvider(config)?.baseUrl).toBe("https://ai.ollama.com");
  });

  it("migrates retired Ollama Cloud provider baseURL aliases to canonical baseUrl", () => {
    const config = {
      models: {
        providers: {
          "ollama-cloud": {
            baseUrl: "https://ollama.com",
            baseURL: "https://ai.ollama.com/",
            api: "ollama",
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.changes).toEqual([
      "Updated models.providers.ollama-cloud.baseURL from retired https://ai.ollama.com/ to https://ollama.com.",
    ]);
    expect(readOllamaCloudProvider(result.config)).toEqual({
      baseUrl: "https://ollama.com",
      api: "ollama",
      models: [],
    });
    expect(readOllamaCloudProvider(config)).toEqual({
      baseUrl: "https://ollama.com",
      baseURL: "https://ai.ollama.com/",
      api: "ollama",
      models: [],
    });
  });
});

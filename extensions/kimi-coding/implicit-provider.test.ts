// Kimi Coding tests cover implicit provider plugin behavior.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

async function runKimiCatalog(params: {
  apiKey?: string;
  explicitProvider?: Record<string, unknown>;
}) {
  const provider = await registerSingleProviderPlugin(plugin);
  const catalogResult = await provider.catalog?.run({
    config: {
      models: {
        providers: params.explicitProvider
          ? {
              "kimi-coding": params.explicitProvider,
            }
          : {},
      },
    },
    resolveProviderApiKey: () => ({ apiKey: params.apiKey ?? "" }),
  } as never);
  return catalogResult ?? null;
}

async function runKimiCatalogProvider(params: {
  apiKey: string;
  explicitProvider?: Record<string, unknown>;
}) {
  const result = await runKimiCatalog(params);
  if (!result || !("provider" in result)) {
    throw new Error("expected Kimi catalog to return one provider");
  }
  return result.provider;
}

describe("Kimi implicit provider (#22409)", () => {
  it("publishes the env vars used by core api-key auto-detection", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.envVars).toEqual(["KIMI_API_KEY", "KIMICODE_API_KEY"]);
  });

  it("does not publish a provider when no API key is resolved", async () => {
    await expect(runKimiCatalog({})).resolves.toBeNull();
  });

  it("publishes the Kimi provider when an API key is resolved", async () => {
    const { models, ...provider } = await runKimiCatalogProvider({ apiKey: "test-key" });

    expect(provider).toEqual({
      baseUrl: "https://api.kimi.com/coding/",
      api: "anthropic-messages",
      headers: {
        "User-Agent": "claude-code/0.1.0",
      },
      apiKey: "test-key",
    });
    // Credential-aware catalog assembly may prioritize the configured default.
    expect(models.map((model) => model.id).toSorted()).toEqual([
      "k3",
      "k3-256k",
      "kimi-for-coding",
      "kimi-for-coding-highspeed",
    ]);
  });

  it("ignores retired kimi-coding provider overrides", async () => {
    const provider = await runKimiCatalogProvider({
      apiKey: "test-key",
      explicitProvider: {
        baseUrl: "https://kimi.example.test/coding/",
        headers: {
          "User-Agent": "custom-kimi-client/1.0",
        },
      },
    });

    expect(provider.baseUrl).toBe("https://api.kimi.com/coding/");
    expect(provider.headers).toEqual({ "User-Agent": "claude-code/0.1.0" });
  });
});

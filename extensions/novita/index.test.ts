import { describe, expect, it } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-wizard.js";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import plugin from "./index.js";

const PROVIDER_ID = "novita";

function registerNovitaPlugin() {
  const providers: unknown[] = [];

  plugin.register(
    createTestPluginApi({
      id: PROVIDER_ID,
      name: "Novita AI Provider",
      source: "test",
      config: {},
      runtime: {} as never,
      registerProvider: (provider) => {
        providers.push(provider);
      },
    }),
  );

  return { providers };
}

describe("novita provider plugin", () => {
  it("registers Novita AI with api-key auth wizard metadata", () => {
    const { providers } = registerNovitaPlugin();
    expect(providers).toHaveLength(1);

    const provider = providers[0] as any;
    expect(provider.id).toBe(PROVIDER_ID);
    expect(provider.label).toBe("Novita AI");
    expect(provider.envVars).toEqual(["NOVITA_API_KEY"]);
    expect(provider.auth).toHaveLength(1);

    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "novita-api-key",
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.provider.id).toBe(PROVIDER_ID);
    expect(resolved?.method.id).toBe("api-key");
  });

  it("resolveDynamicModel returns correct model shape", () => {
    const { providers } = registerNovitaPlugin();
    const provider = providers[0] as any;

    const model = provider.resolveDynamicModel({
      provider: PROVIDER_ID,
      modelId: "deepseek/deepseek-v3.2",
      modelRegistry: { find: () => null },
    });

    expect(model).toMatchObject({
      id: "deepseek/deepseek-v3.2",
      provider: PROVIDER_ID,
      api: "openai-completions",
      baseUrl: "https://api.novita.ai/openai",
    });
    expect(model.contextWindow).toBeGreaterThan(0);
    expect(model.maxTokens).toBeGreaterThan(0);
  });

  it("resolveDynamicModel works for arbitrary model IDs", () => {
    const { providers } = registerNovitaPlugin();
    const provider = providers[0] as any;

    const model = provider.resolveDynamicModel({
      provider: PROVIDER_ID,
      modelId: "some-vendor/some-new-model",
      modelRegistry: { find: () => null },
    });

    expect(model.id).toBe("some-vendor/some-new-model");
    expect(model.provider).toBe(PROVIDER_ID);
    expect(model.api).toBe("openai-completions");
  });

  it("catalog returns null when no API key", async () => {
    const { providers } = registerNovitaPlugin();
    const provider = providers[0] as any;

    const result = await provider.catalog.run({
      resolveProviderApiKey: () => ({ apiKey: undefined }),
    });

    expect(result).toBeNull();
  });

  it("isModernModelRef always returns true", () => {
    const { providers } = registerNovitaPlugin();
    const provider = providers[0] as any;

    expect(provider.isModernModelRef()).toBe(true);
  });
});

import { createTestPluginApi, type TestPluginApiInput } from "openclaw/plugin-sdk/plugin-test-api";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import * as catalog from "./provider-catalog.js";

const bundledProvider = {
  baseUrl: "https://router.huggingface.co/v1",
  api: "openai-completions",
  models: [
    { id: "deepseek-ai/DeepSeek-R1", name: "DeepSeek R1", contextWindow: 131072 },
    { id: "deepseek-ai/DeepSeek-V3.1", name: "DeepSeek V3.1" },
    { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B" },
  ],
};

function registerProvider() {
  const register = vi.fn<NonNullable<TestPluginApiInput["registerProvider"]>>();
  plugin.register(createTestPluginApi({ registerProvider: register }));
  return register.mock.calls[0]?.[0];
}

describe("huggingface plugin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { label: "no key is configured", config: {}, apiKey: undefined },
    {
      label: "discovery is disabled",
      config: {
        plugins: {
          entries: { huggingface: { config: { discovery: { enabled: false } } } },
        },
      },
      apiKey: "hf_test_token",
    },
  ])("keeps the bundled catalog offline when $label", async ({ config, apiKey }) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const resolveProviderAuth = vi.fn<ProviderCatalogContext["resolveProviderAuth"]>(() => ({
      apiKey,
      discoveryApiKey: apiKey,
      mode: apiKey ? "api_key" : "none",
      source: apiKey ? "profile" : "none",
    }));
    const context: ProviderCatalogContext = {
      config,
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth,
    };
    const provider = registerProvider();

    await expect(provider?.catalog?.run(context)).resolves.toBeNull();
    resolveProviderAuth.mockClear();
    const result = await provider?.staticCatalog?.run(context);

    expect(result).toMatchObject({ provider: bundledProvider });
    expect(result).not.toHaveProperty("provider.apiKey");
    expect(result).not.toHaveProperty("provider.models.0.compat");
    expect(resolveProviderAuth).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { source: "environment", apiKey: "HF_TOKEN", discoveryApiKey: "test-env-token" },
    {
      source: "provider config",
      apiKey: "test-config-token",
      discoveryApiKey: "test-config-token",
    },
  ])("keeps the $source credential when an OAuth profile also exists", async (keyAuth) => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ data: [{ id: "test/catalog-model" }] }));
    const context: ProviderCatalogContext = {
      config: {},
      env: {},
      resolveProviderApiKey: () => keyAuth,
      resolveProviderAuth: (_provider, options) => ({
        apiKey: options?.oauthMarker,
        discoveryApiKey: "test-profile-token",
        mode: "oauth",
        source: "profile",
        profileId: "huggingface:default",
      }),
    };

    const result = await registerProvider()?.catalog?.run(context);

    expect(fetch).toHaveBeenCalledTimes(1);
    const request = new Request(...fetch.mock.calls[0]!);
    expect(request.url).toBe("https://router.huggingface.co/v1/models");
    expect(request.headers.get("authorization")).toBe(`Bearer ${keyAuth.discoveryApiKey}`);
    expect(result).toMatchObject({ provider: { apiKey: keyAuth.apiKey } });
  });

  it("discovers models with an OAuth bearer while keeping the credential marker in config", async () => {
    const build = vi.spyOn(catalog, "buildHuggingfaceProvider").mockResolvedValue({
      baseUrl: "https://router.huggingface.co/v1",
      api: "openai-completions",
      models: [],
    });
    const context: ProviderCatalogContext = {
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: (_provider, options) => ({
        apiKey: options?.oauthMarker,
        discoveryApiKey: "test-oauth-bearer",
        mode: "oauth",
        source: "profile",
        profileId: "huggingface:default",
      }),
    };
    const result = await registerProvider()?.catalog?.run(context);
    expect(build).toHaveBeenCalledWith("test-oauth-bearer", { discoveryMode: "strict" });
    expect(result).toMatchObject({ provider: { apiKey: "oauth:huggingface", models: [] } });
  });
});

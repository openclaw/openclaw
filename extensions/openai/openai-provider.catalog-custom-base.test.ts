import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { buildOpenAIProvider } from "./openai-provider.js";
import { resolveModelRoutes } from "./provider-policy-api.js";

afterEach(() => vi.restoreAllMocks());

it("skips OpenAI live discovery for custom OpenAI-compatible base URLs", async () => {
  clearLiveCatalogCacheForTests();
  const customBaseUrl = "https://example-proxy.invalid/v1";
  const apiKey = "sk-custom-openai-compatible";
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected discovery"));

  const result = await buildOpenAIProvider().catalog?.run({
    resolveProviderAuth: () => ({ mode: "api_key", apiKey, source: "profile" }),
    resolveProviderApiKey: () => ({ apiKey }),
    config: { models: { providers: { openai: { baseUrl: customBaseUrl, models: [] } } } },
    env: {},
    agentDir: "/tmp/openai-agent",
    workspaceDir: "/tmp/openai-workspace",
  });

  if (!result || "provider" in result || !result.providers.openai) {
    throw new Error("expected OpenAI custom-base provider catalog");
  }
  const provider = result.providers.openai;
  expect(fetch).not.toHaveBeenCalled();
  expect(result.outcomes).toEqual([]);
  expect(provider.baseUrl).toBe(customBaseUrl);
  expect(provider.api).toBe("openai-responses");
  expect(provider.apiKey).toBe(apiKey);
  const apiModel = provider.models.find((model) => model.api !== "openai-chatgpt-responses");
  expect(apiModel?.baseUrl).toBe(customBaseUrl);
  expect(
    resolveModelRoutes({
      provider: "openai",
      modelId: apiModel?.id,
      configuredProvider: { api: provider.api, baseUrl: customBaseUrl },
      observedRoutes: apiModel ? [{ api: apiModel.api, baseUrl: apiModel.baseUrl }] : [],
    }),
  ).toMatchObject({
    kind: "routes",
    routes: [{ api: provider.api, baseUrl: customBaseUrl }],
  });
});

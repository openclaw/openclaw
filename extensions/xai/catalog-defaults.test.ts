import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelProviderConfig, OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyXaiOAuthConfig } from "./onboard.js";

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: vi.fn().mockRejectedValue(new Error("No runtime credential")),
}));

import plugin from "./index.js";

beforeEach(() => {
  clearLiveCatalogCacheForTests();
  vi.stubEnv("XAI_API_KEY", "");
});
afterEach(() => vi.unstubAllEnvs());

const oauthProvider: ModelProviderConfig = {
  api: "openai-responses",
  auth: "oauth",
  baseUrl: "https://cli-chat-proxy.grok.com/v1",
  models: [],
};

it("preserves the existing primary during OAuth setup", () => {
  const model = {
    primary: "openai/retained-model",
    fallbacks: ["xai/grok-4.3"],
  };
  const config = applyXaiOAuthConfig(
    { agents: { defaults: { model: structuredClone(model) } } },
    oauthProvider,
  );
  expect(config.agents?.defaults?.model).toEqual(model);
});

const proxyUrl = "https://cli-chat-proxy.grok.com/v1";
const apiUrl = "https://api.x.ai/v1";
it.each([
  ["oauth", undefined, proxyUrl, "oauth"],
  ["token", proxyUrl, proxyUrl, "token"],
  ["token", apiUrl, apiUrl, undefined],
  ["api_key", undefined, apiUrl, undefined],
] as const)(
  "keeps the static catalog on the selected %s route (%s)",
  async (mode, baseUrl, expectedUrl, expectedAuth) => {
    const pluginProvider = await registerSingleProviderPlugin(plugin);
    const result = await pluginProvider.staticCatalog?.run({
      config: baseUrl ? { models: { providers: { xai: { baseUrl, models: [] } } } } : {},
      env: {},
      resolveProviderAuth: () => ({
        mode,
        source: "profile",
        apiKey: undefined,
        discoveryApiKey: "selected-fixture",
      }),
      resolveProviderApiKey: () => ({ apiKey: "unselected-fixture" }),
    });
    if (!result || !("provider" in result)) {
      throw new Error("expected a static xAI catalog");
    }
    expect(result.provider.baseUrl).toBe(expectedUrl);
    expect(result.provider.auth).toBe(expectedAuth);
    expect(result.provider.models[0]?.id).toBe("grok-4.7");
    expect(result.provider.models.some((model) => model.id === "auto")).toBe(false);
  },
);

it.each([
  { name: "an existing selection", primary: "xai/grok-4.5", expected: "xai/grok-4.5" },
  { name: "a fresh selection", primary: undefined, expected: "xai/grok-4.7" },
])("applies registered API-key setup with $name", async ({ primary, expected }) => {
  const provider = await registerSingleProviderPlugin(plugin);
  const method = provider.auth.find((entry) => entry.id === "api-key");
  if (!method?.runNonInteractive) {
    throw new Error("expected the registered non-interactive xAI API-key method");
  }
  const fallbacks = ["xai/grok-4.3", "xai/grok-build-0.1"];
  const pinned = { alias: "Pinned", params: { temperature: 0.7 } };
  const defaults = {
    model: { ...(primary ? { primary } : {}), fallbacks: [...fallbacks] },
    models: { "xai/grok-4.5": structuredClone(pinned) },
  };
  const config: OpenClawConfig = { agents: { defaults } };
  const result = await method.runNonInteractive({
    authChoice: "xai-api-key",
    config,
    baseConfig: config,
    opts: {},
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: (code) => {
        throw new Error("Unexpected setup exit: " + code);
      },
    },
    resolveApiKey: async () => ({ key: "synthetic-existing-profile", source: "profile" }),
    toApiKeyCredential: () => {
      throw new Error("Existing profile must not be rewritten");
    },
  });
  expect(result?.agents?.defaults?.model).toEqual({ primary: expected, fallbacks });
  expect(result?.agents?.defaults?.models?.["xai/grok-4.5"]).toEqual(pinned);
});

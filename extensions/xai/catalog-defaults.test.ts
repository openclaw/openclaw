import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import {
  resolveAgentModelPrimaryValue,
  type ModelProviderConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildXaiCatalogModels } from "./model-definitions.js";
import { applyXaiConfig, applyXaiOAuthConfig } from "./onboard.js";

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: vi.fn().mockRejectedValue(new Error("No runtime credential")),
}));

import plugin from "./index.js";

beforeEach(() => {
  clearLiveCatalogCacheForTests();
  vi.stubEnv("XAI_API_KEY", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const oauthProvider: ModelProviderConfig = {
  api: "openai-responses",
  auth: "oauth",
  baseUrl: "https://cli-chat-proxy.grok.com/v1",
  models: [],
};

it.each(["api-key", "oauth"] as const)("uses the curated default for fresh %s setup", (method) => {
  const config = method === "oauth" ? applyXaiOAuthConfig({}, oauthProvider) : applyXaiConfig({});
  expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe("xai/grok-4.6");
  expect(config.agents?.defaults?.models?.["xai/grok-4.6"]?.alias).toBe("Grok");
});

it("keeps a caller's price and input edits out of the curated catalog", () => {
  const customized = buildXaiCatalogModels();
  const first = customized[0];
  if (!first) {
    throw new Error("expected the default curated model");
  }
  first.cost.input = 999;
  first.input.push("audio");

  const fresh = buildXaiCatalogModels()[0];
  expect(fresh?.cost.input).toBe(2);
  expect(fresh?.input).toEqual(["text", "image"]);
});

it.each(["api-key", "oauth"] as const)(
  "preserves the existing primary during %s setup",
  (method) => {
    const original: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "openai/retained-model", fallbacks: ["xai/grok-4.3"] } },
      },
    };
    const config =
      method === "oauth" ? applyXaiOAuthConfig(original, oauthProvider) : applyXaiConfig(original);
    expect(config.agents?.defaults?.model).toEqual({
      primary: "openai/retained-model",
      fallbacks: ["xai/grok-4.3"],
    });
  },
);

it.each([
  {
    label: "OAuth",
    mode: "oauth" as const,
    baseUrl: undefined,
    expectedUrl: "https://cli-chat-proxy.grok.com/v1",
    expectedAuth: "oauth",
  },
  {
    label: "subscription token",
    mode: "token" as const,
    baseUrl: "https://cli-chat-proxy.grok.com/v1",
    expectedUrl: "https://cli-chat-proxy.grok.com/v1",
    expectedAuth: "token",
  },
  {
    label: "API token",
    mode: "token" as const,
    baseUrl: "https://api.x.ai/v1",
    expectedUrl: "https://api.x.ai/v1",
    expectedAuth: undefined,
  },
  {
    label: "API key",
    mode: "api-key" as const,
    baseUrl: undefined,
    expectedUrl: "https://api.x.ai/v1",
    expectedAuth: undefined,
  },
])(
  "keeps the static catalog on the selected $label route",
  async ({ mode, baseUrl, expectedUrl, expectedAuth }) => {
    const pluginProvider = await registerSingleProviderPlugin(plugin);
    const result = await pluginProvider.staticCatalog?.run({
      config: baseUrl ? { models: { providers: { xai: { baseUrl, models: [] } } } } : {},
      env: {},
      resolveProviderAuth: () => ({
        mode,
        source: "fixture",
        discoveryApiKey: "selected-fixture",
      }),
      resolveProviderApiKey: () => ({ apiKey: "unselected-fixture" }),
    });
    if (!result || !("provider" in result)) {
      throw new Error("expected a static xAI catalog");
    }
    expect(result.provider.baseUrl).toBe(expectedUrl);
    expect(result.provider.auth).toBe(expectedAuth);
    expect(result.provider.models[0]?.id).toBe("grok-4.6");
    expect(result.provider.models.some((model) => model.id === "auto")).toBe(false);
  },
);

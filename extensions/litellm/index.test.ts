import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ProviderAuthMethodNonInteractiveContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  capturePluginRegistration,
  requireRegisteredProvider,
  runProviderCatalog,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { afterEach, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../test-support/runtime-spies.js";
import plugin from "./index.js";

const PROXY_URL = "https://litellm.example/v1";
const DEFAULT_MODEL: ModelDefinitionConfig = {
  id: "claude-opus-4-6",
  name: "Claude Opus 4.6",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
};
const AUTHORED_MODEL: ModelDefinitionConfig = {
  ...DEFAULT_MODEL,
  id: "custom-model",
  contextWindow: 1000,
};
function authored(baseUrl = PROXY_URL, apiKey = "  old-key  "): ModelProviderConfig {
  return {
    baseUrl,
    apiKey,
    api: "anthropic-messages",
    request: { allowPrivateNetwork: true },
    models: [structuredClone(AUTHORED_MODEL)],
  };
}
function config(
  providers: Record<string, ModelProviderConfig>,
  mode: "merge" | "replace" = "merge",
): OpenClawConfig {
  return { models: { providers, mode } };
}
const provider = () =>
  requireRegisteredProvider(capturePluginRegistration(plugin).providers, "litellm");
async function authenticate(
  cfg: OpenClawConfig,
  opts: ProviderAuthMethodNonInteractiveContext["opts"] = {},
) {
  return provider().auth[0]?.runNonInteractive?.({
    authChoice: "litellm-api-key",
    config: cfg,
    baseConfig: cfg,
    opts,
    runtime: createRuntimeSpies(),
    resolveApiKey: async (request) => {
      expect(request).toEqual({
        provider: "litellm",
        flagValue: opts.litellmApiKey,
        flagName: "--litellm-api-key",
        envVar: "LITELLM_API_KEY",
      });
      return { key: "litellm-test-key", source: "profile" };
    },
    toApiKeyCredential: () => null,
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  clearLiveCatalogCacheForTests();
});

it.each([false, true])(
  "preserves authored settings with canonical row %s during noninteractive auth",
  async (canonical) => {
    const alias = authored("https://old.example/v1");
    const selected = canonical ? authored("https://canonical.example/v1", "canonical-key") : alias;
    if (canonical) {
      selected.models[0] = { ...AUTHORED_MODEL, params: { temperature: 0.3 } };
    }
    const expected = {
      ...structuredClone(selected),
      api: "openai-completions",
      apiKey: canonical ? "canonical-key" : "old-key",
    };
    const result = await authenticate(
      config({ LiteLLM: alias, ...(canonical ? { litellm: selected } : {}) }),
    );
    expect(result?.models?.providers).toStrictEqual({ litellm: expected });
  },
);

it.each([
  [undefined, "http://localhost:4000/v1/models"],
  ["https://litellm.example", `${PROXY_URL}/models`],
  [" https://proxy.example/litellm/v1// ", "https://proxy.example/litellm/v1/models"],
  [PROXY_URL, `${PROXY_URL}/models`, "LiteLLM"],
  [PROXY_URL, `${PROXY_URL}/models`, "LiteLLM", "https://litellm.example"],
] as const)(
  "discovers models from %j at %j (provider %j, canonical URL %j)",
  async (baseUrl, endpoint, key: "litellm" | "LiteLLM" = "litellm", canonicalBaseUrl?: string) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        input === endpoint
          ? Response.json({ data: [{ id: "proxy-model" }] })
          : new Response("Not Found", { status: 404 }),
      ),
    );
    const result = await runProviderCatalog({
      provider: provider(),
      config: baseUrl
        ? config({
            [key]: { baseUrl, models: [] },
            ...(canonicalBaseUrl ? { litellm: { baseUrl: canonicalBaseUrl, models: [] } } : {}),
          })
        : {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "LITELLM_API_KEY", discoveryApiKey: "sk-test" }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    });
    expect(result).toMatchObject({
      provider: { models: [expect.objectContaining({ id: "proxy-model" })] },
      outcomes: [{ provider: "litellm", status: "ready" }],
    });
  },
);

it.each([
  [PROXY_URL, [], {}],
  ["http://localhost:4000", [DEFAULT_MODEL], {}],
  [PROXY_URL, [AUTHORED_MODEL, DEFAULT_MODEL], config({ litellm: authored() }, "replace")],
] as const)("configures %s without losing authored models", async (baseUrl, models, cfg) => {
  const customBaseUrl = baseUrl === PROXY_URL ? `${baseUrl}/` : undefined;
  const result = await authenticate(cfg, { litellmApiKey: "litellm-test-key", customBaseUrl });
  expect(result?.auth?.profiles).toStrictEqual({
    "litellm:default": { provider: "litellm", mode: "api_key" },
  });
  expect(result?.agents?.defaults).toStrictEqual({
    models: { "litellm/claude-opus-4-6": { alias: "LiteLLM" } },
    model: { primary: "litellm/claude-opus-4-6" },
  });
  expect(result?.models).toStrictEqual(
    config(
      {
        litellm: {
          baseUrl,
          api: "openai-completions",
          models: [...models],
          ...("models" in cfg ? { apiKey: "old-key", request: { allowPrivateNetwork: true } } : {}),
        },
      },
      "models" in cfg ? "replace" : "merge",
    ).models,
  );
});

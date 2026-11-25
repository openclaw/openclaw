import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { jsonResponse, withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModel } from "./model.test-support.js";
import { ollamaProviderDiscovery } from "./provider-discovery.js";

const OLLAMA_LOCAL_AUTH_MARKER = "ollama-local";
const liveEnv = { VITEST: "", NODE_ENV: "development" };
const cloudUrl = "https://ollama.com";
type CatalogOptions = Partial<
  Pick<ProviderCatalogContext, "env" | "providerIds" | "resolveProviderApiKey">
> & {
  provider?: ModelProviderConfig;
};

const configuredProvider = (overrides: Partial<ModelProviderConfig>): ModelProviderConfig => ({
  baseUrl: `${cloudUrl}/v1`,
  models: [createModel("gpt-oss:20b", "GPT-OSS 20B")],
  ...overrides,
});

beforeEach(() => vi.stubEnv("OLLAMA_API_KEY", undefined));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Ollama provider", () => {
  const tagAuthHeaders = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/api/tags"))
      .map(([, init]) => new Headers(init?.headers).get("authorization"));

  async function runOllamaCatalog({ provider, env: overrides, ...context }: CatalogOptions) {
    const env: NodeJS.ProcessEnv = { ...process.env, VITEST: "1", NODE_ENV: "test", ...overrides };
    const apiKey = env.OLLAMA_API_KEY?.trim() ? env.OLLAMA_API_KEY : undefined;
    const result = await ollamaProviderDiscovery.catalog.run({
      config: provider ? { models: { providers: { ollama: provider } } } : {},
      env,
      resolveProviderApiKey: () => ({ apiKey }),
      resolveProviderAuth: () => ({
        apiKey,
        mode: apiKey ? "api_key" : "none",
        source: apiKey ? "env" : "none",
      }),
      ...context,
    });
    return result && "provider" in result ? result.provider : undefined;
  }

  it("skips local discovery for an Ollama Cloud-only scope before auth", async () => {
    const resolveProviderApiKey = vi.fn(() => {
      throw new Error("local auth must stay untouched");
    });

    await expect(
      runOllamaCatalog({ providerIds: ["ollama-cloud"], resolveProviderApiKey }),
    ).resolves.toBeUndefined();
    expect(resolveProviderApiKey).not.toHaveBeenCalled();
  });

  const stubTagsFetch = (names: string[] = [], show?: object) => {
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        return jsonResponse({ models: names.map((name) => ({ name })) });
      }
      return show && url.endsWith("/api/show") ? jsonResponse(show) : jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));
    return fetchMock;
  };

  it("preserves configured OpenAI routing and authenticates discovery", async () => {
    const fetch = stubTagsFetch();
    const baseUrl = "http://remote-ollama:11434/v1";
    const apiKey = "config-ollama-key";
    const provider = await runOllamaCatalog({
      provider: configuredProvider({ baseUrl, api: "openai-completions", apiKey }),
      env: liveEnv,
    });
    expect(provider).toMatchObject({ baseUrl, api: "openai-completions", apiKey });
    expect(tagAuthHeaders(fetch)).toEqual([`Bearer ${apiKey}`]);
  });

  it("caps /api/show requests when /api/tags returns a very large model list", async () => {
    const fetchMock = stubTagsFetch(
      Array.from({ length: 250 }, (_, i) => `model-${i}`),
      { model_info: { "llama.context_length": 65536 } },
    );
    const provider = await runOllamaCatalog({
      env: { ...liveEnv, OLLAMA_API_KEY: OLLAMA_LOCAL_AUTH_MARKER },
    });
    expect(provider).toMatchObject({
      apiKey: OLLAMA_LOCAL_AUTH_MARKER,
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
    });
    expect(tagAuthHeaders(fetchMock)).toEqual([null]);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/show"))).toHaveLength(
      200,
    );
    expect(provider?.models).toHaveLength(200);
  });

  it.each([
    ["does not mint cloud auth", undefined],
    ["preserves resolved cloud env markers", "OLLAMA_API_KEY"],
  ])("%s", async (_name, configuredKey) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));
    const provider = await runOllamaCatalog({
      provider: configuredProvider({ apiKey: configuredKey }),
      env: { ...liveEnv, ...(configuredKey ? { OLLAMA_API_KEY: "real-secret" } : {}) },
      resolveProviderApiKey: () => ({
        apiKey: configuredKey,
        discoveryApiKey: configuredKey ? "real-secret" : undefined,
      }),
    });
    expect(provider).toMatchObject({ baseUrl: cloudUrl, api: "ollama" });
    expect(provider?.apiKey).toBe(configuredKey);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(provider?.models).toHaveLength(1);
  });
});

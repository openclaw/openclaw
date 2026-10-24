import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { jsonResponse, withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModel } from "./model.test-support.js";
import { ollamaProviderDiscovery } from "./provider-discovery.js";

const OLLAMA_LOCAL_AUTH_MARKER = "ollama-local";
const liveEnv = { VITEST: "", NODE_ENV: "development" };
const cloudUrl = "https://ollama.com";

const createConfiguredModel = () =>
  createModel("gpt-oss:20b", "GPT-OSS 20B", { contextWindow: 8_192, maxTokens: 81_920 });

beforeEach(() => vi.stubEnv("OLLAMA_API_KEY", undefined));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Ollama provider", () => {
  const countFetchCallUrls = (fetchMock: ReturnType<typeof vi.fn>, suffix: string): number =>
    fetchMock.mock.calls.filter(([input]) => String(input).endsWith(suffix)).length;

  const stubOllamaFetch = (fetchMock: ReturnType<typeof vi.fn>) =>
    vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));

  async function runOllamaCatalog(params: {
    provider?: ModelProviderConfig;
    env?: NodeJS.ProcessEnv;
    providerIds?: readonly string[];
    resolveProviderApiKey?: () => { apiKey: string | undefined; discoveryApiKey?: string };
  }) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      VITEST: "1",
      NODE_ENV: "test",
      ...params.env,
    };
    const apiKey = env.OLLAMA_API_KEY?.trim() ? env.OLLAMA_API_KEY : undefined;
    const result = await ollamaProviderDiscovery.catalog.run({
      config: params.provider ? { models: { providers: { ollama: params.provider } } } : {},
      env,
      ...(params.providerIds !== undefined ? { providerIds: params.providerIds } : {}),
      resolveProviderApiKey: params.resolveProviderApiKey ?? (() => ({ apiKey })),
      resolveProviderAuth: () => ({
        apiKey,
        mode: apiKey ? "api_key" : "none",
        source: apiKey ? "env" : "none",
      }),
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
    stubOllamaFetch(fetchMock);
    return fetchMock;
  };

  it("preserves configured OpenAI routing and authenticates discovery", async () => {
    const fetch = stubTagsFetch();
    const baseUrl = "http://remote-ollama:11434/v1";
    const apiKey = "config-ollama-key";
    const provider = await runOllamaCatalog({
      provider: { baseUrl, api: "openai-completions", apiKey, models: [createConfiguredModel()] },
      env: liveEnv,
    });
    expect(provider).toMatchObject({ baseUrl, api: "openai-completions", apiKey });
    expect(
      fetch.mock.calls
        .filter(([url]) => String(url).endsWith("/api/tags"))
        .map(([, init]) => new Headers(init?.headers).get("authorization")),
    ).toEqual([`Bearer ${apiKey}`]);
  });

  it("caps /api/show requests when /api/tags returns a very large model list", async () => {
    const fetchMock = stubTagsFetch(
      [
        "deepseek-r1:latest",
        "llama3.3:latest",
        ...Array.from({ length: 248 }, (_, idx) => `model-${idx}`),
      ],
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
    expect(provider?.models.slice(0, 2)).toMatchObject([
      { id: "deepseek-r1:latest", reasoning: true },
      { id: "llama3.3:latest", reasoning: false },
    ]);
    expect(countFetchCallUrls(fetchMock, "/api/tags")).toBe(1);
    expect(
      fetchMock.mock.calls
        .filter(([url]) => String(url).endsWith("/api/tags"))
        .map(([, init]) => new Headers(init?.headers).get("authorization")),
    ).toEqual([null]);
    expect(countFetchCallUrls(fetchMock, "/api/show")).toBe(200);
    expect(provider?.models).toHaveLength(200);
  });

  it.each([
    ["does not mint cloud auth", undefined],
    ["preserves resolved cloud env markers", "OLLAMA_API_KEY"],
  ])("%s", async (_name, configuredKey) => {
    const fetchMock = vi.fn();
    stubOllamaFetch(fetchMock);
    const provider = await runOllamaCatalog({
      provider: {
        baseUrl: `${cloudUrl}/v1`,
        models: [createConfiguredModel()],
        apiKey: configuredKey,
      },
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

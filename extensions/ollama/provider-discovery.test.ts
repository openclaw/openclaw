import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createModel } from "./model.test-support.js";
import { ollamaProviderDiscovery } from "./provider-discovery.js";

const OLLAMA_LOCAL_AUTH_MARKER = "ollama-local";
const liveEnv = { VITEST: "", NODE_ENV: "development" };
const cloudUrl = "https://ollama.com";
const localUrl = "http://127.0.0.1:11434";

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

  const expectDiscoveryCallCounts = (
    fetchMock: ReturnType<typeof vi.fn>,
    params: { tags: number; show: number },
  ) => {
    expect({
      tags: countFetchCallUrls(fetchMock, "/api/tags"),
      show: countFetchCallUrls(fetchMock, "/api/show"),
    }).toEqual(params);
  };

  const tagsAuthorization = (
    fetchMock: Mock<(input: unknown, init?: RequestInit) => Promise<Response>>,
  ) =>
    fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith("/api/tags"))
      .map(([, init]) => new Headers(init?.headers).get("authorization"));

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
      agentDir: mkdtempSync(join(tmpdir(), "openclaw-test-")),
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

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
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

  it.each([
    { baseUrl: "http://192.168.20.14:11434/v1", apiKey: undefined },
    { baseUrl: "http://remote-ollama:11434/v1", apiKey: "config-ollama-key" },
  ])(
    "preserves OpenAI-compatible routing and configured auth at $baseUrl",
    async ({ baseUrl, apiKey }) => {
      const fetchMock = stubTagsFetch();
      const provider = await runOllamaCatalog({
        provider: {
          baseUrl,
          api: "openai-completions",
          apiKey,
          models: apiKey ? [createConfiguredModel()] : [],
        },
        env: apiKey ? liveEnv : { OLLAMA_API_KEY: "test-key" },
      });
      expect(provider).toMatchObject({ baseUrl, api: "openai-completions" });
      if (apiKey) {
        expect(provider?.apiKey).toBe(apiKey);
        expect(tagsAuthorization(fetchMock)).toEqual([`Bearer ${apiKey}`]);
      } else {
        expect(countFetchCallUrls(fetchMock, "/api/tags")).toBe(1);
      }
    },
  );

  it("auto-registers ollama provider when models are discovered locally", async () => {
    const fetchMock = stubTagsFetch(["deepseek-r1:latest", "llama3.3:latest"], { model_info: {} });
    const provider = await runOllamaCatalog({
      env: { ...liveEnv, OLLAMA_API_KEY: OLLAMA_LOCAL_AUTH_MARKER },
    });
    expect(provider).toMatchObject({
      apiKey: OLLAMA_LOCAL_AUTH_MARKER,
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      models: [{ id: "deepseek-r1:latest", reasoning: true }, { reasoning: false }],
    });
    expect(provider?.models).toHaveLength(2);
    expectDiscoveryCallCounts(fetchMock, { tags: 1, show: 2 });
  });

  it("caps /api/show requests when /api/tags returns a very large model list", async () => {
    const fetchMock = stubTagsFetch(
      Array.from({ length: 250 }, (_, idx) => `model-${idx}`),
      { model_info: { "llama.context_length": 65536 } },
    );
    const provider = await runOllamaCatalog({
      env: { ...liveEnv, OLLAMA_API_KEY: "test-key" },
    });
    expectDiscoveryCallCounts(fetchMock, { tags: 1, show: 200 });
    expect(provider?.models).toHaveLength(200);
  });

  it.each([
    ["does not mint cloud auth", cloudUrl, undefined, undefined],
    ["preserves resolved cloud env markers", cloudUrl, "OLLAMA_API_KEY", "OLLAMA_API_KEY"],
    ["keeps local discovery anonymous", localUrl, "OLLAMA_API_KEY", OLLAMA_LOCAL_AUTH_MARKER],
  ])("%s", async (_name, baseUrl, configuredKey, expectedKey) => {
    const local = baseUrl === localUrl;
    const fetchMock = local ? stubTagsFetch() : vi.fn();
    if (!local) {
      stubOllamaFetch(fetchMock);
    }
    const provider = await runOllamaCatalog({
      provider: {
        baseUrl: `${baseUrl}/v1`,
        models: [createConfiguredModel()],
        apiKey: configuredKey,
      },
      env: { ...liveEnv, ...(configuredKey ? { OLLAMA_API_KEY: "real-secret" } : {}) },
      resolveProviderApiKey: () => ({
        apiKey: configuredKey,
        discoveryApiKey: configuredKey ? "real-secret" : undefined,
      }),
    });
    expect(provider).toMatchObject({ baseUrl, api: "ollama" });
    expect(provider?.apiKey).toBe(expectedKey);
    if (local) {
      expect(tagsAuthorization(fetchMock)).toEqual([null]);
      expect(provider?.models).toEqual([]);
    } else {
      expect(fetchMock).not.toHaveBeenCalled();
      expect(provider?.models).toHaveLength(1);
    }
  });
});

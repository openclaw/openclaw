import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SecretInput } from "openclaw/plugin-sdk/secret-input";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLazyOllamaWebSearchProvider } from "./web-search-provider-registration.js";
import { createOllamaWebSearchProvider } from "./web-search-provider.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock:
    vi.fn<
      (
        request: Parameters<typeof fetchWithSsrFGuard>[0],
      ) => Promise<ReturnType<typeof guardedResponse>>
    >(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

type OllamaProviderConfigOverride = Partial<
  NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]
>;

function createOllamaConfig(provider: OllamaProviderConfigOverride = {}): OpenClawConfig {
  return {
    models: {
      providers: {
        ollama: {
          baseUrl: "http://ollama.local:11434/v1",
          api: "ollama",
          models: [],
          ...provider,
        },
      },
    },
  };
}

async function runOllamaWebSearchSetup(
  config: OpenClawConfig,
  provider = createOllamaWebSearchProvider(),
) {
  if (!provider.runSetup) {
    throw new Error("Expected Ollama web search setup");
  }
  const notes: Array<{ title?: string; message: string }> = [];
  const next = await provider.runSetup({
    config,
    prompter: {
      note: async (message: string, title?: string) => {
        notes.push({ title, message });
      },
    },
  } as never);
  return { next, notes };
}

function guardedResponse(
  body: string | object,
  init: ResponseInit = {},
  release: () => Promise<void> = vi.fn(async () => {}),
) {
  return {
    response: typeof body === "string" ? new Response(body, init) : Response.json(body, init),
    release,
  };
}

const LOCAL_THEN_CLOUD_URLS = [
  "http://ollama.local:11434/api/experimental/web_search",
  "http://ollama.local:11434/api/web_search",
  "https://ollama.com/api/web_search",
];

function searchResponse() {
  return guardedResponse({
    results: [{ title: "Cloud", url: "https://example.com", content: "result" }],
  });
}

function mockLocalMissesThenCloudSearch() {
  fetchWithSsrFGuardMock
    .mockResolvedValueOnce(guardedResponse("not found", { status: 404 }))
    .mockResolvedValueOnce(guardedResponse("not found", { status: 404 }))
    .mockResolvedValueOnce(searchResponse());
}

function mockSuccessfulSearchResponse() {
  fetchWithSsrFGuardMock.mockResolvedValue(guardedResponse({ results: [] }));
}

async function runOllamaWebSearch(
  config: OpenClawConfig,
  query = "openclaw",
): Promise<Record<string, unknown>> {
  return await createSearchTool(config).execute({ query });
}

function createSearchTool(config = createOllamaConfig()) {
  const tool = createOllamaWebSearchProvider().createTool({ config });
  if (!tool) {
    throw new Error("Expected Ollama web search tool");
  }
  return tool;
}

function fetchRequest(index = 0) {
  return fetchWithSsrFGuardMock.mock.calls[index]![0];
}

function authorization(index = 0) {
  return new Headers(fetchRequest(index).init?.headers).get("Authorization");
}

function expectHostedRequest(apiKey: string) {
  const request = fetchRequest();
  expect(request).toEqual({
    url: "https://ollama.com/api/web_search",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: "openclaw", max_results: 5 }),
    },
    timeoutMs: 15_000,
    policy: { allowPrivateNetwork: true, hostnameAllowlist: ["ollama.com"] },
    auditContext: "ollama-web-search.search",
  });
  // The deadline must be guard-owned so it also bounds DNS/proxy preflight.
  expect(request.init?.signal).toBeUndefined();
}

async function expectConfiguredRefFailure(input: SecretInput, message: string) {
  await expect(runOllamaWebSearch(createOllamaConfig({ apiKey: input }))).rejects.toThrow(message);
  expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
}

async function expectSetupNote(
  config: OpenClawConfig,
  message: string,
  provider = createOllamaWebSearchProvider(),
) {
  const { next, notes } = await runOllamaWebSearchSetup(config, provider);
  expect(next).toBe(config);
  expect(notes).toEqual([{ title: "Ollama Web Search", message }]);
}

describe("ollama web search provider", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it("uses the configured Ollama host and enables the plugin in config", async () => {
    const provider = createOllamaWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }

    const applied = provider.applySelectionConfig({});

    expect(provider.credentialPath).toBe("");
    expect(applied.plugins?.entries?.ollama?.enabled).toBe(true);
    mockSuccessfulSearchResponse();
    await runOllamaWebSearch(createOllamaConfig());
    expect(fetchRequest().url).toBe("http://ollama.local:11434/api/experimental/web_search");
  });

  it("passes caller cancellation to the guard without replacing its owned timeout", async () => {
    mockSuccessfulSearchResponse();
    const tool = createSearchTool();
    const controller = new AbortController();

    await tool.execute({ query: "ollama active cancellation" }, { signal: controller.signal });

    expect(fetchRequest().signal).toBe(controller.signal);
    expect(fetchRequest().init?.signal).toBeUndefined();
  });

  // Between attempts, the first response finishes and the next response stays
  // valid, so only the cancellation can stop the fallback: no further request
  // may start.
  it.each(["before dispatch", "between attempts"] as const)(
    "does not start requests after caller cancellation: %s",
    async (phase) => {
      const controller = new AbortController();
      const reason = new Error("Ollama caller canceled");
      const firstRelease = vi.fn(async () => controller.abort(reason));
      fetchWithSsrFGuardMock
        .mockResolvedValueOnce(guardedResponse("not found", { status: 404 }, firstRelease))
        .mockResolvedValueOnce(searchResponse());
      const tool = createSearchTool();
      if (phase === "before dispatch") {
        controller.abort(reason);
      }

      await expect(
        tool.execute({ query: "ollama cancellation" }, { signal: controller.signal }),
      ).rejects.toBe(reason);
      const expectedCalls = phase === "before dispatch" ? 0 : 1;
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(expectedCalls);
      expect(firstRelease).toHaveBeenCalledTimes(expectedCalls);
      if (phase === "between attempts") {
        expect(fetchRequest().url).toBe("http://ollama.local:11434/api/experimental/web_search");
      }
    },
  );

  it("prefers the plugin web search base URL over the model provider host", async () => {
    mockSuccessfulSearchResponse();
    await runOllamaWebSearch({
      ...createOllamaConfig(),
      plugins: {
        entries: { ollama: { config: { webSearch: { baseUrl: "http://localhost:11434/v1" } } } },
      },
    });
    expect(fetchRequest().url).toBe("http://localhost:11434/api/experimental/web_search");
  });

  it.each([undefined, "configured-host-key"])(
    "scopes cloud fallback credentials with selected-host key %s",
    async (apiKey) => {
      await withEnvAsync({ OLLAMA_API_KEY: "cloud-secret" }, async () => {
        mockLocalMissesThenCloudSearch();

        const result = await runOllamaWebSearch(createOllamaConfig({ apiKey }));

        expect(result.count).toBe(1);
        expect([authorization(0), authorization(1), authorization(2)]).toEqual([
          apiKey ? `Bearer ${apiKey}` : null,
          apiKey ? `Bearer ${apiKey}` : null,
          "Bearer cloud-secret",
        ]);
        expect(fetchWithSsrFGuardMock.mock.calls.map((call) => call[0].url)).toEqual(
          LOCAL_THEN_CLOUD_URLS,
        );
        expect(fetchRequest(2).url).toBe("https://ollama.com/api/web_search");
      });
    },
  );

  it("resolves provider apiKey env SecretRefs for web search requests", async () => {
    const resolvedKey = "resolved-ref-value";
    await withEnvAsync({ OLLAMA_WEB_SEARCH_REF: resolvedKey }, async () => {
      fetchWithSsrFGuardMock.mockResolvedValueOnce(searchResponse());

      const result = await runOllamaWebSearch(
        createOllamaConfig({
          baseUrl: "https://ollama.com",
          apiKey: "${OLLAMA_WEB_SEARCH_REF}",
        }),
      );

      expect(result.count).toBe(1);
      expectHostedRequest(resolvedKey);
    });
  });

  it.each<[string, SecretInput, string]>([
    [
      "does not use ambient env fallback when a configured apiKey SecretRef is unavailable",
      { source: "env", provider: "default", id: "OLLAMA_WEB_SEARCH_REF" },
      "models.providers.ollama.apiKey env SecretRef OLLAMA_WEB_SEARCH_REF is not available",
    ],
    [
      "does not use ambient env fallback for non-env apiKey SecretRefs",
      { source: "file", provider: "vault", id: "/providers/ollama/web-search" },
      "models.providers.ollama.apiKey SecretRef cannot be resolved by Ollama web search",
    ],
  ])("%s", async (_title, apiKey, error) => {
    await withEnvAsync(
      { OLLAMA_WEB_SEARCH_REF: undefined, OLLAMA_API_KEY: "ambient-cloud-value" },
      async () => {
        await expectConfiguredRefFailure(apiKey, error);
      },
    );
  });

  it("surfaces API-key guidance for hosted Ollama 401 responses", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue(guardedResponse("", { status: 401 }));

    await expect(
      runOllamaWebSearch(createOllamaConfig({ baseUrl: "https://ollama.com" })),
    ).rejects.toMatchObject({
      status: 401,
      statusCode: 401,
      message: expect.stringContaining(
        "Set OLLAMA_API_KEY or configure models.providers.ollama.apiKey",
      ),
    });
  });

  it("warns when Ollama is not reachable during setup without cancelling", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("connect failed"));

    await expectSetupNote(
      createOllamaConfig(),
      [
        "Ollama Web Search requires Ollama to be running.",
        "Expected host: http://ollama.local:11434",
        "Start Ollama before using this provider.",
      ].join("\n"),
    );
  });

  it("warns when the configured model provider selects hosted search without an API key", async () => {
    const config = createOllamaConfig({ baseUrl: "https://ollama.com" });
    await withEnvAsync({ OLLAMA_API_KEY: undefined }, async () => {
      await expectSetupNote(
        config,
        "Hosted Ollama Web Search requires an API key. Set OLLAMA_API_KEY or configure models.providers.ollama.apiKey.",
        createLazyOllamaWebSearchProvider(),
      );
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    });
  });

  it("warns when ollama signin is missing during setup without cancelling", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(guardedResponse({ models: [] }))
      .mockResolvedValueOnce(
        guardedResponse(
          { error: "not signed in", signin_url: "https://ollama.com/signin" },
          { status: 401 },
        ),
      );

    await expectSetupNote(
      createOllamaConfig(),
      "Ollama Web Search requires `ollama signin`.\nhttps://ollama.com/signin",
    );
  });
});

import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SecretInput } from "openclaw/plugin-sdk/secret-input";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createModelProviderConfig } from "../../test-support/model-provider-config.test-support.js";
import { createOllamaWebSearchProvider } from "../web-search-provider.js";
import { createLazyOllamaWebSearchProvider } from "./web-search-provider-registration.js";

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
  return createModelProviderConfig({
    ollama: { baseUrl: "http://ollama.local:11434/v1", api: "ollama", models: [], ...provider },
  });
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

const mockSuccessfulSearchResponse = () =>
  fetchWithSsrFGuardMock.mockResolvedValue(guardedResponse({ results: [] }));

const runOllamaWebSearch = (config: OpenClawConfig) =>
  createSearchTool(config).execute({ query: "openclaw" });

function createSearchTool(config = createOllamaConfig(), searchConfig?: Record<string, unknown>) {
  return expectDefined(
    createOllamaWebSearchProvider().createTool({ config, searchConfig }),
    "Ollama web search tool",
  );
}

const fetchRequest = (index = 0) => fetchWithSsrFGuardMock.mock.calls[index]![0];
const authorization = (index = 0) =>
  new Headers(fetchRequest(index).init?.headers).get("Authorization");

async function expectSetupNote(
  config: OpenClawConfig,
  message: string,
  provider = createOllamaWebSearchProvider(),
) {
  const note = vi.fn(async () => {});
  const runSetup = expectDefined(provider.runSetup, "Ollama web search setup");
  expect(await runSetup({ config, prompter: { note } } as never)).toBe(config);
  expect(note.mock.calls).toEqual([[message, "Ollama Web Search"]]);
}

describe("ollama web search provider", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it("uses the configured Ollama host and enables the plugin in config", async () => {
    const provider = createOllamaWebSearchProvider();
    const applied = expectDefined(provider.applySelectionConfig, "applySelectionConfig")({});
    expect(applied.plugins?.entries?.ollama?.enabled).toBe(true);
    mockSuccessfulSearchResponse();
    await runOllamaWebSearch(createOllamaConfig());
    expect(fetchRequest().url).toBe("http://ollama.local:11434/api/experimental/web_search");
    expect(fetchRequest().init?.body).toBe(JSON.stringify({ query: "openclaw", max_results: 5 }));
  });

  it("uses tools.web.search maxResults and timeoutSeconds; an explicit count wins", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(guardedResponse({ results: [] }))
      .mockResolvedValueOnce(guardedResponse({ results: [] }));
    const tool = createSearchTool(createOllamaConfig(), { maxResults: 2, timeoutSeconds: 2 });

    await tool.execute({ query: "openclaw" });
    await tool.execute({ query: "openclaw", count: 7 });

    expect(fetchRequest(0).init?.body).toBe(JSON.stringify({ query: "openclaw", max_results: 2 }));
    expect(fetchRequest(0).timeoutMs).toBe(2_000);
    expect(fetchRequest(1).init?.body).toBe(JSON.stringify({ query: "openclaw", max_results: 7 }));
  });

  // A valid fallback stays available; only cancellation may prevent dispatch.
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
        expect(fetchRequest().signal).toBe(controller.signal);
        expect(fetchRequest().init?.signal).toBeUndefined();
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
        fetchWithSsrFGuardMock
          .mockResolvedValueOnce(guardedResponse("not found", { status: 404 }))
          .mockResolvedValueOnce(guardedResponse("not found", { status: 404 }))
          .mockResolvedValueOnce(searchResponse());

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
      expect(authorization()).toBe(`Bearer ${resolvedKey}`);
      expect(fetchRequest()).toMatchObject({
        url: "https://ollama.com/api/web_search",
        timeoutMs: 15_000,
        policy: { allowPrivateNetwork: true, hostnameAllowlist: ["ollama.com"] },
      });
      expect(fetchRequest().init?.signal).toBeUndefined();
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
        await expect(runOllamaWebSearch(createOllamaConfig({ apiKey }))).rejects.toThrow(error);
        expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
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

  it.each([
    [
      "unreachable",
      "Ollama Web Search requires Ollama to be running.\nExpected host: http://ollama.local:11434\nStart Ollama before using this provider.",
    ],
    ["unsigned", "Ollama Web Search requires `ollama signin`.\nhttps://ollama.com/signin"],
  ])("warns during %s setup without cancelling", async (state, message) => {
    if (state === "unreachable") {
      fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("connect failed"));
    } else {
      fetchWithSsrFGuardMock
        .mockResolvedValueOnce(guardedResponse({ models: [] }))
        .mockResolvedValueOnce(
          guardedResponse(
            { error: "not signed in", signin_url: "https://ollama.com/signin" },
            { status: 401 },
          ),
        );
    }
    await expectSetupNote(createOllamaConfig(), message);
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
});

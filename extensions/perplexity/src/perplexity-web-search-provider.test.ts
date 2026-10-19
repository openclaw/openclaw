import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const endpointMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/provider-web-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-web-search")>();
  return {
    ...actual,
    withTrustedWebSearchEndpoint: endpointMock,
  };
});

import { createPerplexityWebSearchProvider } from "./perplexity-web-search-provider.js";

const openRouterApiKeyEnv = ["OPENROUTER_API", "KEY"].join("_");
const perplexityApiKeyEnv = ["PERPLEXITY_API", "KEY"].join("_");
const openRouterPerplexityApiKey = ["sk", "or", "v1", "test"].join("-");
const directKey = ["pplx", "test"].join("-");
const enterprisePerplexityApiKey = ["enterprise", "perplexity", "test"].join("-");
const directUrl = "https://api.perplexity.ai";
const routerUrl = "https://openrouter.ai/api/v1";
const defaultModel = "perplexity/sonar-pro";
const unsupportedSuffix =
  " only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable ";

function chatResponse(content = "Grounded answer", citations?: string[]) {
  return { choices: [{ message: { content } }], ...(citations ? { citations } : {}) };
}

function requestBody() {
  const [request] = endpointMock.mock.calls[0] as [{ init: RequestInit }];
  return JSON.parse(request.init.body as string);
}

type RoutingCase = {
  name: string;
  key: string;
  source: "config" | "env" | "secretRef";
  fallbackEnvVar?: string;
  url: string;
  model?: string;
  overrides?: { baseUrl?: string; model?: string };
};

function mockResponse(body: unknown): void {
  endpointMock.mockImplementationOnce(
    async (_params: { init: RequestInit }, run: (response: Response) => Promise<unknown>) =>
      await run(Response.json(body)),
  );
}

function createTool(structured: boolean, apiKey = directKey, cacheTtlMinutes?: number) {
  const webSearch = {
    apiKey,
    ...(structured ? {} : { baseUrl: directUrl }),
  };
  const tool = createPerplexityWebSearchProvider().createTool({
    config: { plugins: { entries: { perplexity: { config: { webSearch } } } } },
    searchConfig: { cacheTtlMinutes },
  });
  if (!tool) {
    throw new Error("Expected tool definition");
  }
  return tool;
}

describe("perplexity web search provider", () => {
  beforeEach(() => {
    endpointMock.mockReset();
  });

  it.each([true, false])("redacts reflected credentials (native=%s)", async (structured) => {
    endpointMock.mockImplementationOnce(
      async (_params: unknown, run: (response: Response) => Promise<unknown>) =>
        run(new Response("rejected s7Key", { status: 401 })),
    );
    const label = structured ? "Perplexity Search" : "Perplexity";
    await expect(createTool(structured, "s7Key").execute({ query: "redaction" })).rejects.toThrow(
      `${label} API error (401): rejected ***`,
    );
  });

  it("points missing-key users to fetch/browser alternatives", async () => {
    await withEnvAsync(
      { [perplexityApiKeyEnv]: undefined, [openRouterApiKeyEnv]: undefined },
      async () => {
        const tool = createTool(true, "");
        await expect(tool.execute({ query: "OpenClaw docs" })).resolves.toEqual({
          error: "missing_perplexity_api_key",
          message:
            "web_search (perplexity) needs an API key. Set PERPLEXITY_API_KEY or OPENROUTER_API_KEY in the Gateway environment, or configure plugins.entries.perplexity.config.webSearch.apiKey. If you do not want to configure a search API key, use web_fetch for a specific URL or the browser tool for interactive pages.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      },
    );
  });

  it.each`
    structured | args                                                                                                       | error                           | message
    ${false}   | ${{ country: "US", language: "en", date_after: "2024-01-01", domain_filter: ["a.test"], max_tokens: 1 }}   | ${"unsupported_country"}        | ${`country filtering is${unsupportedSuffix}it.`}
    ${false}   | ${{ language: "invalid", date_after: "2024-01-01", domain_filter: ["a.test"], max_tokens: 1 }}             | ${"unsupported_language"}       | ${`language filtering is${unsupportedSuffix}it.`}
    ${false}   | ${{ freshness: "day", date_after: "2024-01-01", domain_filter: ["a.test"], max_tokens: 1 }}                | ${"unsupported_date_filter"}    | ${`date_after/date_before are${unsupportedSuffix}them.`}
    ${false}   | ${{ domain_filter: ["a.test"], max_tokens: 1 }}                                                            | ${"unsupported_domain_filter"}  | ${`domain_filter is${unsupportedSuffix}it.`}
    ${false}   | ${{ max_tokens_per_page: 1 }}                                                                              | ${"unsupported_content_budget"} | ${`max_tokens and max_tokens_per_page are${unsupportedSuffix}them.`}
    ${false}   | ${{ freshness: "invalid", country: "US", max_tokens: 0 }}                                                  | ${"invalid_freshness"}          | ${"freshness must be day, week, month, or year."}
    ${true}    | ${{ language: "invalid", freshness: "day", date_after: "invalid" }}                                        | ${"invalid_language"}           | ${"language must be a 2-letter ISO 639-1 code like 'en', 'de', or 'fr'."}
    ${true}    | ${{ date_after: "invalid", date_before: "also-invalid", domain_filter: ["allowed.test", "-denied.test"] }} | ${"invalid_date"}               | ${"date_after must be YYYY-MM-DD format."}
    ${true}    | ${{ date_after: "2024-01-01", date_before: "invalid" }}                                                    | ${"invalid_date"}               | ${"date_before must be YYYY-MM-DD format."}
  `(
    "preserves validation precedence (native=$structured, args=$args): $error",
    async ({
      structured,
      args,
      error,
      message,
    }: {
      structured: boolean;
      args: Record<string, unknown>;
      error: string;
      message: string;
    }) => {
      await expect(
        createTool(structured).execute({ query: "validation", ...args }),
      ).resolves.toEqual({
        error,
        message,
        docs: "https://docs.openclaw.ai/tools/web",
      });
    },
  );

  it("validates chat token budgets before unsupported country precedence", async () => {
    await expect(
      createTool(false).execute({ query: "validation", country: "US", max_tokens: 0 }),
    ).rejects.toThrow("max_tokens must be a positive integer.");
  });

  it("does not start an already canceled request", async () => {
    endpointMock.mockResolvedValue({ results: [] });
    const tool = createTool(true);
    const controller = new AbortController();
    controller.abort(new Error("Perplexity caller canceled"));

    await expect(
      tool.execute({ query: "perplexity pre-canceled" }, { signal: controller.signal }),
    ).rejects.toThrow("Perplexity caller canceled");
    expect(endpointMock).not.toHaveBeenCalled();
  });

  it("disables cache reads and writes without replacing existing entries", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    for (const result of ["initial", "fresh", "uncached"]) {
      mockResponse({
        results: [{ title: result, url: `https://example.test/${result}` }],
      });
    }

    try {
      const args = { query: "perplexity disabled cache" };
      const originalTool = createTool(true, undefined, 15);
      const initial = await originalTool.execute(args);
      expect(await originalTool.execute(args)).toEqual({ ...initial, cached: true });
      expect(endpointMock).toHaveBeenCalledOnce();

      now.mockReturnValue(1_700_000_060_000);
      const currentTool = createTool(true, undefined, 0);
      const fresh = await currentTool.execute(args);
      expect(fresh.cached).toBeUndefined();
      expect(fresh).toMatchObject({
        results: [expect.objectContaining({ url: "https://example.test/fresh" })],
      });
      expect(endpointMock).toHaveBeenCalledTimes(2);

      expect((await currentTool.execute(args)).cached).toBeUndefined();
      expect(endpointMock).toHaveBeenCalledTimes(3);
      expect(await originalTool.execute(args)).toEqual({ ...initial, cached: true });
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    { name: "missing choices", response: {} },
    { name: "whitespace content", response: { choices: [{ message: { content: " \n " } }] } },
  ])("rejects and does not cache chat-completions $name", async ({ name, response }) => {
    mockResponse(response);
    mockResponse(chatResponse("  Recovered grounded answer  ", ["https://example.test/recovered"]));

    const tool = createTool(false);
    const args = { query: `perplexity empty answer ${name}` };
    await expect(tool.execute(args)).rejects.toThrow(
      "Perplexity search returned no final answer. Retry the query or choose another search provider.",
    );

    const recovered = await tool.execute(args);
    expect(recovered.content).toContain("  Recovered grounded answer  ");
    expect(recovered.citations).toEqual(["https://example.test/recovered"]);
    expect(endpointMock).toHaveBeenCalledTimes(2);
  });

  it("caps returned and cached results when the Perplexity Search API exceeds the requested count", async () => {
    mockResponse({
      results: [
        { url: "https://example.com/first", title: "First", snippet: "first" },
        { url: "https://example.com/second", title: "Second", snippet: "second" },
        { url: "https://example.com/third", title: "Third", snippet: "third" },
      ],
    });
    const tool = createTool(true);
    const args = { query: "perplexity result count owner", count: 1 };

    const first = await tool.execute(args);
    const cached = await tool.execute(args);

    expect(endpointMock).toHaveBeenCalledOnce();
    expect(requestBody()).toMatchObject({ max_results: 1 });
    expect(first).toMatchObject({
      provider: "perplexity",
      count: 1,
      results: [{ url: "https://example.com/first" }],
    });
    expect(first.results).toHaveLength(1);
    expect(cached).toEqual({ ...first, cached: true });
  });

  it.each([
    { name: "chat completions", structured: false, expectedRequests: 1 },
    { name: "native Search API", structured: true, expectedRequests: 2 },
  ])(
    "uses count as a cache dimension only when $name sends it upstream",
    async ({ name, structured, expectedRequests }) => {
      const annotation = {
        type: "url_citation",
        url_citation: { url: "https://example.test/citation" },
      };
      const message = { content: "Grounded answer", annotations: [annotation] };
      const response = structured ? { results: [] } : { choices: [{ message }] };
      mockResponse(response);
      if (structured) {
        mockResponse(response);
      }

      const tool = createTool(structured);
      const query = `perplexity cache count ${name}`;
      const first = await tool.execute({ query, count: 1 });
      const second = await tool.execute({ query, count: 7 });
      const third = await tool.execute({ query, count: 1 });

      expect(first.cached).toBeUndefined();
      expect(second.cached).toBe(structured ? undefined : true);
      expect(third.cached).toBe(true);
      expect(endpointMock).toHaveBeenCalledTimes(expectedRequests);
      if (structured) {
        expect(first.results).toEqual([]);
        expect(first.count).toBe(0);
      } else {
        expect(first.content).toContain("Grounded answer");
        expect(first.citations).toEqual(["https://example.test/citation"]);
      }
    },
  );

  it.each([
    { name: "native Search API", structured: true },
    { name: "chat completions", structured: false },
  ])("cancels an in-flight $name request", async ({ name, structured }) => {
    endpointMock.mockImplementation(
      async (params: { signal?: AbortSignal }) =>
        await new Promise<never>((_resolve, reject) => {
          if (!params.signal) {
            reject(new Error("Perplexity request lost caller cancellation"));
            return;
          }
          params.signal.addEventListener("abort", () => reject(params.signal?.reason as Error), {
            once: true,
          });
        }),
    );
    const tool = createTool(structured);
    const controller = new AbortController();
    const result = tool.execute(
      { query: `perplexity in-flight cancellation ${name}` },
      { signal: controller.signal },
    );

    await vi.waitFor(() => expect(endpointMock).toHaveBeenCalledOnce());
    controller.abort(new Error("Perplexity request canceled in flight"));

    await expect(result).rejects.toThrow("Perplexity request canceled in flight");
    expect(endpointMock.mock.calls[0]?.[0]?.signal).toBe(controller.signal);
  });

  it.each`
    name                                                   | key                           | source         | fallbackEnvVar         | url                                             | model                    | overrides
    ${"unrecognized configured key"}                       | ${enterprisePerplexityApiKey} | ${"config"}    | ${undefined}           | ${`${directUrl}/search`}                        | ${undefined}             | ${undefined}
    ${"configured key ahead of native environment key"}    | ${openRouterPerplexityApiKey} | ${"config"}    | ${perplexityApiKeyEnv} | ${`${routerUrl}/chat/completions`}              | ${defaultModel}          | ${undefined}
    ${"native environment source ahead of key prefix"}     | ${openRouterPerplexityApiKey} | ${"env"}       | ${perplexityApiKeyEnv} | ${`${directUrl}/search`}                        | ${undefined}             | ${undefined}
    ${"OpenRouter environment source ahead of key prefix"} | ${directKey}                  | ${"env"}       | ${openRouterApiKeyEnv} | ${`${routerUrl}/chat/completions`}              | ${defaultModel}          | ${undefined}
    ${"resolved OpenRouter SecretRef"}                     | ${openRouterPerplexityApiKey} | ${"secretRef"} | ${undefined}           | ${`${routerUrl}/chat/completions`}              | ${defaultModel}          | ${undefined}
    ${"explicit direct base URL"}                          | ${directKey}                  | ${"config"}    | ${undefined}           | ${`${directUrl}/chat/completions`}              | ${"sonar-pro"}           | ${{ baseUrl: ` ${directUrl}/ ` }}
    ${"explicit remote base URL"}                          | ${directKey}                  | ${"config"}    | ${undefined}           | ${"https://search.example/v1/chat/completions"} | ${defaultModel}          | ${{ baseUrl: "https://search.example/v1/" }}
    ${"explicit model"}                                    | ${directKey}                  | ${"config"}    | ${undefined}           | ${`${directUrl}/chat/completions`}              | ${"sonar-reasoning-pro"} | ${{ model: " perplexity/sonar-reasoning-pro " }}
    ${"blank overrides"}                                   | ${directKey}                  | ${"config"}    | ${undefined}           | ${`${directUrl}/search`}                        | ${undefined}             | ${{ baseUrl: " ", model: " " }}
  `(
    "routes $name consistently through metadata, schema and execution",
    async (entry: RoutingCase) => {
      const { key, source, url, fallbackEnvVar, overrides, model, name } = entry;
      await withEnvAsync(
        {
          [perplexityApiKeyEnv]: undefined,
          [openRouterApiKeyEnv]: undefined,
          ...(fallbackEnvVar ? { [fallbackEnvVar]: source === "env" ? key : directKey } : {}),
        },
        async () => {
          const provider = createPerplexityWebSearchProvider();
          const webSearch = {
            ...(source === "config" ? { apiKey: key } : {}),
            ...(source === "secretRef"
              ? { apiKey: { source: "env", provider: "default", id: "PERPLEXITY_TEST_REF" } }
              : {}),
            ...overrides,
          };
          const config = { plugins: { entries: { perplexity: { config: { webSearch } } } } };
          const metadata = await provider.resolveRuntimeMetadata?.({
            config,
            resolvedCredential: { value: key, source, fallbackEnvVar },
          });
          const chat = model !== undefined;
          expect(metadata).toEqual({
            perplexityTransport: chat ? "chat_completions" : "search_api",
          });
          if (source === "secretRef") {
            provider.setConfiguredCredentialValue?.(config, key);
          }
          const tool = provider.createTool({
            config,
            runtimeMetadata: { providerSource: "configured", diagnostics: [], ...metadata },
          });
          if (!tool) {
            throw new Error("Expected Perplexity tool");
          }
          if (chat) {
            expect(tool.parameters).not.toHaveProperty("properties.country");
          } else {
            expect(tool.parameters).toHaveProperty("properties.country");
          }
          mockResponse(chat ? chatResponse() : { results: [] });
          const query = `routing ${name}`;
          await tool.execute({ query });
          expect(endpointMock).toHaveBeenCalledOnce();
          const [request] = endpointMock.mock.calls[0] as [{ url: string; init: RequestInit }];
          expect(request.url).toBe(url);
          expect(new Headers(request.init.headers).get("authorization")).toBe(`Bearer ${key}`);
          expect(JSON.parse(request.init.body as string)).toEqual(
            chat
              ? { model, messages: [{ role: "user", content: query }] }
              : { query, max_results: 5 },
          );
        },
      );
    },
  );

  it("sends official date filter fields in the Search API request body", async () => {
    mockResponse({ results: [] });

    await createTool(true).execute({
      query: "OpenClaw releases",
      date_after: "2024-01-01",
      date_before: "2024-06-30",
    });

    expect(endpointMock).toHaveBeenCalledOnce();
    expect(requestBody()).toEqual({
      query: "OpenClaw releases",
      max_results: 5,
      search_after_date_filter: "1/1/2024",
      search_before_date_filter: "6/30/2024",
    });
  });

  it.each([
    ["max_tokens", 1_000_001, "max_tokens must be a positive integer."],
    ["max_tokens_per_page", 1.5, "max_tokens_per_page must be a positive integer."],
  ])("rejects invalid native token budget %s=%s", async (key, value, message) => {
    await expect(
      createTool(true).execute({ query: "OpenClaw docs", [key]: value }),
    ).rejects.toThrow(message);
  });
});

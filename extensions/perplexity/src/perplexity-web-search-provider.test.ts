import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";

const endpointMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/provider-web-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-web-search")>();
  return { ...actual, withTrustedWebSearchEndpoint: endpointMock };
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

function chatResponse(content = "Grounded answer", citations?: string[]) {
  return { choices: [{ message: { content } }], ...(citations ? { citations } : {}) };
}

const request = (): { url: string; init: RequestInit; signal?: AbortSignal } => {
  const call = endpointMock.mock.calls[0];
  assert(call, "Expected an endpoint request");
  return call[0];
};
const requestBody = () => JSON.parse(request().init.body as string);

type RoutingCase = {
  name: string;
  key: string;
  source: "config" | "env" | "secretRef";
  fallbackEnvVar?: string;
  url: string;
  model?: string;
  overrides?: { baseUrl?: string; model?: string };
};
type ValidationCase = {
  structured: boolean;
  args: Record<string, unknown>;
  error: string | { error: string; message: string };
};
type ResponseRunner = (response: Response) => Promise<unknown>;

function mockResponse(body: unknown): void {
  endpointMock.mockImplementationOnce(async (_params: { init: RequestInit }, run: ResponseRunner) =>
    run(Response.json(body)),
  );
}

function searchResponse(...names: string[]) {
  return {
    results: names.map((name) => ({
      title: name,
      url: `https://example.test/${name}`,
      snippet: name,
    })),
  };
}

function createTool(structured: boolean, apiKey = directKey, cacheTtlMinutes?: number) {
  const webSearch = { apiKey, ...(structured ? {} : { baseUrl: directUrl }) };
  const tool = createPerplexityWebSearchProvider().createTool({
    config: { plugins: { entries: { perplexity: { config: { webSearch } } } } },
    searchConfig: { cacheTtlMinutes },
  });
  assert(tool, "Expected tool definition");
  return tool;
}

beforeEach(() => {
  endpointMock.mockReset();
  vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
});
afterEach(() => vi.restoreAllMocks());

it.each([true, false])("redacts reflected credentials (native=%s)", async (structured) => {
  endpointMock.mockImplementationOnce(async (_params: unknown, run: ResponseRunner) =>
    run(new Response("rejected s7Key", { status: 401 })),
  );
  const label = structured ? "Perplexity Search" : "Perplexity";
  await expect(createTool(structured, "s7Key").execute({ query: "redaction" })).rejects.toThrow(
    `${label} API error (401): rejected ***`,
  );
});

it("points missing-key users to fetch/browser alternatives", () =>
  withEnvAsync({ [perplexityApiKeyEnv]: undefined, [openRouterApiKeyEnv]: undefined }, async () => {
    await expect(createTool(true, "").execute({ query: "OpenClaw docs" })).resolves.toEqual({
      error: "missing_perplexity_api_key",
      message:
        "web_search (perplexity) needs an API key. Set PERPLEXITY_API_KEY or OPENROUTER_API_KEY in the Gateway environment, or configure plugins.entries.perplexity.config.webSearch.apiKey. If you do not want to configure a search API key, use web_fetch for a specific URL or the browser tool for interactive pages.",
      docs: "https://docs.openclaw.ai/tools/web",
    });
  }));

it.each`
  structured | args                                                                                                       | error
  ${false}   | ${{ country: "US", language: "en", date_after: "2024-01-01", domain_filter: ["a.test"], max_tokens: 1 }}   | ${"unsupported_country"}
  ${false}   | ${{ language: "invalid", date_after: "2024-01-01", domain_filter: ["a.test"], max_tokens: 1 }}             | ${"unsupported_language"}
  ${false}   | ${{ freshness: "day", date_after: "2024-01-01", domain_filter: ["a.test"], max_tokens: 1 }}                | ${"unsupported_date_filter"}
  ${false}   | ${{ domain_filter: ["a.test"], max_tokens: 1 }}                                                            | ${"unsupported_domain_filter"}
  ${false}   | ${{ max_tokens_per_page: 1 }}                                                                              | ${"unsupported_content_budget"}
  ${false}   | ${{ freshness: "invalid", country: "US", max_tokens: 0 }}                                                  | ${"invalid_freshness"}
  ${true}    | ${{ language: "invalid", freshness: "day", date_after: "invalid" }}                                        | ${"invalid_language"}
  ${true}    | ${{ date_after: "invalid", date_before: "also-invalid", domain_filter: ["allowed.test", "-denied.test"] }} | ${{ error: "invalid_date", message: "date_after must be YYYY-MM-DD format." }}
  ${true}    | ${{ date_after: "2024-01-01", date_before: "invalid" }}                                                    | ${{ error: "invalid_date", message: "date_before must be YYYY-MM-DD format." }}
`(
  "validates $error before later options (native=$structured)",
  async ({ structured, args, error }: ValidationCase) => {
    await expect(
      createTool(structured).execute({ query: "validation", ...args }),
    ).resolves.toMatchObject(typeof error === "string" ? { error } : error);
  },
);

it("disables cache reads and writes without replacing existing entries", async () => {
  for (const result of ["initial", "fresh", "uncached"]) {
    mockResponse(searchResponse(result));
  }

  const args = { query: "perplexity disabled cache" };
  const originalTool = createTool(true, undefined, 15);
  const initial = await originalTool.execute(args);
  expect(await originalTool.execute(args)).toEqual({ ...initial, cached: true });

  const currentTool = createTool(true, undefined, 0);
  const fresh = await currentTool.execute(args);
  expect(fresh.cached).toBeUndefined();
  expect(fresh.results).toMatchObject([{ url: "https://example.test/fresh" }]);
  const uncached = await currentTool.execute(args);
  expect(uncached.results).toMatchObject([{ url: "https://example.test/uncached" }]);
  expect(await originalTool.execute(args)).toEqual({ ...initial, cached: true });
});

it.each([true, false])("isolates cached credentials (native=%s)", async (structured) => {
  endpointMock.mockImplementation(async (params: { init: RequestInit }, run: ResponseRunner) => {
    const account = new Headers(params.init.headers)
      .get("authorization")
      ?.slice("Bearer perplexity-".length);
    const body = structured
      ? { results: [{ title: account, url: `https://example.com/${account}` }] }
      : chatResponse(account, [`https://example.com/${account}`]);
    return run(Response.json(body));
  });
  const accountA = createTool(structured, "perplexity-account-a");
  const accountB = createTool(structured, "perplexity-account-b");
  const args = { query: `Perplexity credential-scoped answers ${structured}` };
  const first = await accountA.execute(args);
  const second = await accountB.execute(args);
  const repeated = await accountA.execute(args);

  expect([first, second]).toMatchObject(
    ["account-a", "account-b"].map((account) =>
      structured
        ? { results: [{ url: `https://example.com/${account}` }] }
        : {
            content: expect.stringContaining(account),
            citations: [`https://example.com/${account}`],
          },
    ),
  );
  expect(repeated).toEqual({ ...first, cached: true });
  expect(endpointMock).toHaveBeenCalledTimes(2);
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
});

it.each([false, true])("maps filters and caches count (native=%s)", async (structured) => {
  const annotation = {
    type: "url_citation",
    url_citation: { url: "https://example.test/citation" },
  };
  const response = structured
    ? searchResponse("first", "second")
    : { choices: [{ message: { content: "Grounded answer", annotations: [annotation] } }] };
  mockResponse(response);
  if (structured) {
    mockResponse(response);
  }

  const tool = createTool(structured);
  const query = `perplexity cache count ${structured}`;
  const args = {
    query,
    ...(structured ? { date_after: "2024-01-01", date_before: "2024-06-30" } : {}),
  };
  const first = await tool.execute({ ...args, count: 1 });
  const second = await tool.execute({ ...args, count: 7 });
  const third = await tool.execute({ ...args, count: 1 });

  expect(second.cached).toBe(structured ? undefined : true);
  expect(third).toEqual({ ...first, cached: true });
  expect(endpointMock).toHaveBeenCalledTimes(structured ? 2 : 1);
  if (structured) {
    expect(requestBody()).toEqual({
      query,
      max_results: 1,
      search_after_date_filter: "1/1/2024",
      search_before_date_filter: "6/30/2024",
    });
    expect(first).toMatchObject({ count: 1, results: [{ url: "https://example.test/first" }] });
    expect(second).toMatchObject({ count: 2 });
  } else {
    expect(first.citations).toEqual(["https://example.test/citation"]);
  }
});

it.each([
  [true, true],
  [true, false],
  [false, false],
])("cancels native=%s, alreadyCanceled=%s", async (structured, alreadyCanceled) => {
  endpointMock.mockImplementation(async ({ signal }: { signal?: AbortSignal }) => {
    assert(signal, "Perplexity request lost caller cancellation");
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          const reason: unknown = signal.reason;
          assert(reason instanceof Error, "Expected an Error cancellation reason");
          reject(reason);
        },
        { once: true },
      );
    });
  });
  const controller = new AbortController();
  const reason = new Error("Perplexity caller canceled");
  if (alreadyCanceled) {
    controller.abort(reason);
  }
  const result = createTool(structured).execute(
    { query: `perplexity cancellation ${structured} ${alreadyCanceled}` },
    { signal: controller.signal },
  );
  if (alreadyCanceled) {
    expect(endpointMock).not.toHaveBeenCalled();
  } else {
    await vi.waitFor(() => expect(endpointMock).toHaveBeenCalledOnce());
    controller.abort(reason);
    expect(request().signal).toBe(controller.signal);
  }
  await expect(result).rejects.toThrow(reason.message);
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
  async ({ key, source, url, fallbackEnvVar, overrides, model, name }: RoutingCase) => {
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
        expect(metadata?.perplexityTransport).toBe(chat ? "chat_completions" : "search_api");
        if (source === "secretRef") {
          provider.setConfiguredCredentialValue?.(config, key);
        }
        const tool = provider.createTool({
          config,
          runtimeMetadata: { providerSource: "configured", diagnostics: [], ...metadata },
        });
        assert(tool, "Expected Perplexity tool");
        const schema = expect(tool.parameters);
        (chat ? schema.not : schema).toHaveProperty("properties.country");
        mockResponse(chat ? chatResponse() : { results: [] });
        const query = `routing ${name}`;
        await expect(tool.execute({ query })).resolves.toMatchObject(
          chat
            ? { content: expect.stringContaining("Grounded answer") }
            : { count: 0, results: [] },
        );
        expect(request().url).toBe(url);
        expect(new Headers(request().init.headers).get("authorization")).toBe(`Bearer ${key}`);
        expect(requestBody()).toEqual(
          chat
            ? { model, messages: [{ role: "user", content: query }] }
            : { query, max_results: 5 },
        );
      },
    );
  },
);

it.each<[boolean, Record<string, unknown>, string]>([
  [false, { country: "US", max_tokens: 0 }, "max_tokens must be a positive integer."],
  [true, { max_tokens: 1_000_001 }, "max_tokens must be a positive integer."],
  [true, { max_tokens_per_page: 1.5 }, "max_tokens_per_page must be a positive integer."],
])("rejects bad budgets (native=%s)", async (structured, args, message) => {
  await expect(createTool(structured).execute({ query: "validation", ...args })).rejects.toThrow(
    message,
  );
});

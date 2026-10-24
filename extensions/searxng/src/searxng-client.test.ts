import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, expect, it, vi } from "vitest";
import { runSearxngSearch } from "./searxng-client.js";

installPinnedHostnameTestHooks();
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const baseUrl = "http://127.0.0.1:8888";
const query = "openclaw";
const requestUrl = `${baseUrl}/search?q=${query}&format=json`;
function searchConfig(endpoint: unknown, categories?: string, language?: string) {
  const webSearch = { baseUrl: endpoint, categories, language };
  return { plugins: { entries: { searxng: { config: { webSearch } } } } };
}

function search(params: Partial<Parameters<typeof runSearxngSearch>[0]> = {}) {
  params.config ??= searchConfig(baseUrl);
  params.config.tools = { web: { search: { cacheTtlMinutes: 0 } } };
  return runSearxngSearch({ query, ...params });
}

function mockFetch(...bodies: (Response | unknown[])[]) {
  const fetch = vi.spyOn(globalThis, "fetch");
  for (const body of bodies) {
    fetch.mockResolvedValueOnce(body instanceof Response ? body : Response.json({ results: body }));
  }
  return fetch;
}

function expectRequests(fetch: ReturnType<typeof mockFetch>, ...urls: string[]) {
  expect(fetch.mock.calls).toEqual(urls.map((url) => [url, expect.anything()]));
}

function row(path: string, fields: Record<string, unknown> = {}) {
  return { title: path, url: `https://example.com/${path}`, ...fields };
}

it("builds the request URL from plugin config", async () => {
  const fetch = mockFetch([]);
  await search({ config: searchConfig(`${baseUrl}/search/`, "general,news", "en") });

  expectRequests(fetch, `${requestUrl}&categories=general%2Cnews&language=en`);
});

it.each([
  {
    source: "allowed env ref",
    endpoint: "http://localhost:8888/",
    target: "http://localhost:8888",
  },
  {
    source: "ambient env",
    endpoint: "https://search.local/searxng///",
    target: "https://search.local/searxng",
  },
])("normalizes the $source endpoint in the request", async ({ source, endpoint, target }) => {
  vi.stubEnv("SEARXNG_BASE_URL", endpoint);
  const fetch = mockFetch([]);
  const config =
    source === "allowed env ref"
      ? searchConfig({ source: "env", provider: "default", id: "SEARXNG_BASE_URL" })
      : {};
  await search({ config });
  expectRequests(fetch, `${target}/search?q=openclaw&format=json`);
});

it.each(["missing endpoint", "blocked explicit ref"])(
  "rejects %s before requesting",
  async (source) => {
    vi.stubEnv("SEARXNG_BASE_URL", source === "missing endpoint" ? "" : "https://ambient.example/");
    const config: OpenClawConfig =
      source === "missing endpoint"
        ? {}
        : {
            ...searchConfig({ source: "env", provider: "restricted", id: "SEARXNG_BASE_URL" }),
            secrets: { providers: { restricted: { source: "env", allowlist: [] } } },
          };
    const fetch = mockFetch([]);
    await expect(search({ config })).rejects.toThrow(
      "SearXNG base URL is not configured. Set SEARXNG_BASE_URL or configure plugins.entries.searxng.config.webSearch.baseUrl.",
    );
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("normalizes, filters, and caps provider result rows", async () => {
  mockFetch([
    row("cat", { content: "Meow", img_src: "https://img.test/cat.jpg" }),
    row("bad-title", { title: { text: "bad" } }),
    row("bad-url", { url: 3 }),
    row("text", { content: { text: "bad" } }),
    row("capped"),
  ]);

  expect(await search({ query: "kittens", count: 2 })).toMatchObject({
    count: 2,
    results: [
      {
        url: "https://example.com/cat",
        title: expect.stringContaining("cat"),
        snippet: expect.stringContaining("Meow"),
        img_src: "https://img.test/cat.jpg",
        siteName: "example.com",
      },
      { url: "https://example.com/text" },
    ],
  });
});

it("retries an empty category search with general results", async () => {
  const fetch = mockFetch([], [row("rain")]);
  const result = await search({ categories: "weather,news" });

  expectRequests(
    fetch,
    `${requestUrl}&categories=weather%2Cnews`,
    `${requestUrl}&categories=general`,
  );
  expect(result).toMatchObject({ count: 1, results: [{ url: "https://example.com/rain" }] });
});

it("preserves the upstream HTTP error status", async () => {
  mockFetch(new Response("upstream rejected search", { status: 429 }));
  await expect(search()).rejects.toMatchObject({ status: 429, statusCode: 429 });
});

it("rejects invalid and incomplete response bodies", async () => {
  const fetch = mockFetch(new Response("{"));
  await expect(search()).rejects.toThrow("SearXNG returned invalid JSON.");

  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls++ === 0) {
        controller.enqueue(new TextEncoder().encode("partial"));
      } else {
        controller.error(new Error("stream reset"));
      }
    },
  });
  fetch.mockResolvedValueOnce(new Response(stream));
  await expect(search()).rejects.toThrow("SearXNG response incomplete after 7 bytes.");
});

it.each(["example.com", "internal"])("gates private redirects from search.%s", async (host) => {
  const redirect = "https://127.0.0.1/search";
  const fetch = mockFetch(Response.redirect(redirect), [row("local")]);
  const endpoint = `https://search.${host}/searxng`;
  const pending = search({ config: searchConfig(endpoint) });
  if (host === "internal") {
    await expect(pending).resolves.toMatchObject({
      results: [{ url: "https://example.com/local" }],
    });
  } else {
    await expect(pending).rejects.toMatchObject({ name: "SsrFBlockedError" });
  }
  expectRequests(
    fetch,
    `${endpoint}/search?q=openclaw&format=json`,
    ...(host === "internal" ? [redirect] : []),
  );
});

it("rejects cleartext public hosts", async () => {
  const fetch = mockFetch([]);
  await expect(search({ config: searchConfig("http://search.example.com:8080") })).rejects.toThrow(
    "SearXNG HTTP base URL must target a trusted private or loopback host. Use https:// for public hosts.",
  );
  expect(fetch).not.toHaveBeenCalled();
});

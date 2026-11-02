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
const requestUrl = `${baseUrl}/search?q=openclaw&format=json`;
function searchConfig(endpoint: unknown, categories?: string, language?: string) {
  const webSearch = { baseUrl: endpoint, categories, language };
  return { plugins: { entries: { searxng: { config: { webSearch } } } } };
}

function search(params: Partial<Parameters<typeof runSearxngSearch>[0]> = {}) {
  params.config ??= searchConfig(baseUrl);
  params.config.tools = { web: { search: { cacheTtlMinutes: 0 } } };
  return runSearxngSearch({ query: "openclaw", ...params });
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

const envRef = { source: "env", provider: "default", id: "SEARXNG_BASE_URL" };

it.each([
  ["http://localhost:8888/", "http://localhost:8888", searchConfig(envRef)],
  ["https://search.local/searxng///", "https://search.local/searxng", {}],
] as const)("resolves endpoint %s", async (endpoint, target, config) => {
  vi.stubEnv("SEARXNG_BASE_URL", endpoint);
  const fetch = mockFetch([]);
  await search({ config, categories: "general" });
  expectRequests(fetch, `${target}/search?q=openclaw&format=json&categories=general`);
});

const blockedConfig: OpenClawConfig = {
  ...searchConfig({ ...envRef, provider: "restricted" }),
  secrets: { providers: { restricted: { source: "env", allowlist: [] } } },
};
it.each([
  [{}, "", "SearXNG base URL is not configured."],
  [blockedConfig, "https://ambient.example/", "SearXNG base URL is not configured."],
  [searchConfig("http://example.com"), "", "must target a trusted private or loopback host"],
] as const)("rejects unsafe or missing config %j", async (config, ambient, error) => {
  vi.stubEnv("SEARXNG_BASE_URL", ambient);
  const fetch = mockFetch([]);
  await expect(search({ config })).rejects.toThrow(error);
  expect(fetch).not.toHaveBeenCalled();
});

it("builds the configured request and normalizes, filters, and caps its results", async () => {
  const fetch = mockFetch([
    row("cat", { content: "Meow", img_src: "https://img.test/cat.jpg" }),
    row("bad-title", { title: { text: "bad" } }),
    row("bad-url", { url: 3 }),
    row("text", { content: { text: "bad" } }),
    row("capped"),
  ]);

  const config = searchConfig(`${baseUrl}/search/`, "general,news", "en");
  expect(await search({ config, count: 2 })).toMatchObject({
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
  expectRequests(fetch, `${requestUrl}&categories=general%2Cnews&language=en`);
});

it("retries an empty category search with general results", async () => {
  const fetch = mockFetch([], [row("rain")]);
  const result = await search({ categories: "weather,news" });

  const urls = ["weather%2Cnews", "general"].map((v) => `${requestUrl}&categories=${v}`);
  expectRequests(fetch, ...urls);
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
        return controller.enqueue(new TextEncoder().encode("partial"));
      }
      controller.error(new Error("stream reset"));
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
    await expect(pending).resolves.toMatchObject({ count: 1 });
  } else {
    await expect(pending).rejects.toMatchObject({ name: "SsrFBlockedError" });
  }
  expect(fetch).toHaveBeenCalledTimes(host === "internal" ? 2 : 1);
});

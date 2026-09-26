import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGeminiWebSearchProvider } from "./src/gemini-web-search-provider.js";

const mocks = vi.hoisted(() => ({
  citations: [] as Array<{ web: { uri: string; title?: string } }>,
  resolveRedirect: vi.fn<(url: string, signal?: AbortSignal) => Promise<string>>(),
}));

vi.mock("openclaw/plugin-sdk/provider-web-search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-web-search")>()),
  resolveCitationRedirectUrl: mocks.resolveRedirect,
  withTrustedWebSearchEndpoint: async (
    _options: unknown,
    run: (response: Response) => Promise<unknown>,
  ) =>
    run(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: "Grounded answer" }] },
              groundingMetadata: { groundingChunks: mocks.citations },
            },
          ],
        }),
      ),
    ),
}));

function createTool() {
  const tool = createGeminiWebSearchProvider().createTool({
    config: {
      plugins: { entries: { google: { config: { webSearch: { apiKey: "test-api-key" } } } } },
    },
    searchConfig: { provider: "gemini", cacheTtlMinutes: 0 },
  });
  if (!tool) {
    throw new Error("Expected Gemini search tool");
  }
  return tool;
}

beforeEach(() => {
  mocks.citations = [];
  mocks.resolveRedirect.mockReset().mockImplementation(async (url) => url);
});

afterEach(() => vi.restoreAllMocks());

describe("Gemini citation enrichment", () => {
  it("resolves only the first twenty admitted citations and reports truncation", async () => {
    mocks.citations = Array.from({ length: 1_001 }, (_, index) => ({
      web: { uri: `https://example.com/${index}`, title: `Source ${index}` },
    }));
    const result = await createTool().execute({ query: "citation count cap" });
    expect(mocks.resolveRedirect).toHaveBeenCalledTimes(20);
    expect(result).toMatchObject({
      truncated: true,
      citations: mocks.citations
        .slice(0, 20)
        .map(({ web }) => ({ url: web.uri, title: web.title })),
    });
  });

  it("shares the output scan limit and URL validation before making requests", async () => {
    mocks.citations = [
      ...Array.from({ length: 999 }, () => ({ web: { uri: "not a URL" } })),
      { web: { uri: "https://example.com/first source" } },
      { web: { uri: "https://example.com/outside-scan" } },
    ];
    const result = await createTool().execute({ query: "citation scan cap" });
    expect(mocks.resolveRedirect).toHaveBeenCalledTimes(1);
    expect(mocks.resolveRedirect.mock.calls[0]?.[0]).toBe("https://example.com/first%20source");
    expect(result).toMatchObject({
      truncated: true,
      citations: [{ url: "https://example.com/first%20source" }],
    });
  });

  it("reserves URL space without deduplicating equal citations", async () => {
    const url = `https://example.com/${"x".repeat(1_980)}`;
    mocks.citations = Array.from({ length: 20 }, (_, index) => ({
      web: { uri: url, title: `Source ${index}` },
    }));
    const result = await createTool().execute({ query: "citation URL budget" });
    const expectedCount = Math.floor(20_000 / url.length);
    expect(mocks.resolveRedirect).toHaveBeenCalledTimes(expectedCount);
    expect(result).toMatchObject({
      truncated: true,
      citations: mocks.citations.slice(0, expectedCount).map(({ web }) => ({
        url: web.uri,
        title: web.title,
      })),
    });
  });

  it("passes cancellation to active redirects and never starts a later batch", async () => {
    mocks.citations = Array.from({ length: 30 }, (_, index) => ({
      web: { uri: `https://example.com/${index}` },
    }));
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    mocks.resolveRedirect.mockImplementation(async (url) => {
      if (mocks.resolveRedirect.mock.calls.length === 10) {
        started.resolve();
      }
      await release.promise;
      return url;
    });
    const controller = new AbortController();
    const reason = new Error("search cancelled while resolving citations");
    const tool = createTool();
    const result = tool.execute({ query: "citation cancellation" }, { signal: controller.signal });
    await started.promise;
    controller.abort(reason);
    release.resolve();
    await expect(result).rejects.toBe(reason);
    expect(mocks.resolveRedirect).toHaveBeenCalledTimes(10);
    expect(
      mocks.resolveRedirect.mock.calls.every(([, signal]) => signal === controller.signal),
    ).toBe(true);

    mocks.resolveRedirect.mockClear();
    await expect(tool.execute({ query: "citation cancellation" })).resolves.toMatchObject({
      provider: "gemini",
    });
    expect(mocks.resolveRedirect).toHaveBeenCalledTimes(20);
  });
});

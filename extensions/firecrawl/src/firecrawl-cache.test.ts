import { createServer, type Server } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { captureFirecrawlTools } from "./firecrawl-tools.test-support.js";

describe("Firecrawl search cache", () => {
  let server: Server;
  let baseUrl: string;
  let body: string;
  let credentialBody: ((authorization: string) => Promise<string>) | undefined;
  let authorizations: string[];

  beforeEach(async () => {
    body = "original";
    credentialBody = undefined;
    authorizations = [];
    server = createServer((request, response) => {
      const authorization = request.headers.authorization ?? "";
      authorizations.push(authorization);
      void Promise.resolve(credentialBody?.(authorization) ?? body).then(
        (content) => {
          const data = [{ url: `https://example.com/${content}`, title: content }];
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ success: true, data }));
        },
        (error: unknown) =>
          response.destroy(new Error("credential response failed", { cause: error })),
      );
    });
    baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const closed = server[Symbol.asyncDispose]();
    server.closeAllConnections();
    await closed;
  });

  async function search(query: string, cacheTtlMinutes: number, apiKey = "cache-test-key") {
    const tool = captureFirecrawlTools({
      tools: { web: { search: { cacheTtlMinutes } } },
      plugins: { entries: { firecrawl: { config: { webSearch: { baseUrl, apiKey } } } } },
    })("firecrawl_search");
    return (await tool.execute("cache-test", { query })).details;
  }

  function expectResult(result: unknown, content: string, calls: number, cached?: boolean) {
    expect(result).toMatchObject({ results: [{ url: `https://example.com/${content}` }] });
    expect(authorizations).toHaveLength(calls);
    if (cached) {
      expect(result).toMatchObject({ cached: true });
    } else if (cached === false) {
      expect(result).not.toHaveProperty("cached");
    }
  }

  it.each(["search", "scrape"] as const)(
    "keeps the %s endpoint and credential in the same operation scope",
    async (operation) => {
      const scrapeRequests: unknown[] = [];
      const scrapeServer = createServer((request, response) => {
        scrapeRequests.push([request.url, request.headers.authorization]);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ success: true, data: { markdown: "scoped content" } }));
      });
      try {
        const scrapeUrl = `http://127.0.0.1:${await listenOnLoopback(scrapeServer)}`;
        const tool = captureFirecrawlTools({
          tools: { web: { search: { cacheTtlMinutes: 0 } } },
          plugins: {
            entries: {
              firecrawl: {
                config: {
                  webSearch: { apiKey: "scope-search-fixture", baseUrl },
                  webFetch: { apiKey: "scope-scrape-fixture", baseUrl: scrapeUrl },
                },
              },
            },
          },
        })(`firecrawl_${operation}`);
        await tool.execute("scoped-request", {
          query: "scoped search",
          url: "https://example.com/scoped-scrape",
        });
        expect(authorizations).toEqual(
          operation === "search" ? ["Bearer scope-search-fixture"] : [],
        );
        expect(scrapeRequests).toEqual(
          operation === "scrape" ? [["/v2/scrape", "Bearer scope-scrape-fixture"]] : [],
        );
      } finally {
        const closed = scrapeServer[Symbol.asyncDispose]();
        scrapeServer.closeAllConnections();
        await closed;
      }
    },
  );

  it("keeps interleaved account results and warm reuse scoped to their credentials", async () => {
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    credentialBody = async (authorization) => {
      if (authorization === "Bearer account-a") {
        started.resolve();
        await finish.promise;
        return "account-a";
      }
      return "account-b";
    };
    const query = "credential-scoped Firecrawl result reuse";
    const first = search(query, 15, "account-a");
    try {
      await started.promise;
      expectResult(await search(query, 15, "account-b"), "account-b", 2);
      finish.resolve();
      expectResult(await first, "account-a", 2);
      for (const account of ["b", "a"]) {
        expectResult(await search(query, 15, `account-${account}`), `account-${account}`, 2, true);
      }
      expect(authorizations).toEqual(["Bearer account-a", "Bearer account-b"]);
    } finally {
      finish.resolve();
      await first;
    }
  });

  it.each([0, 15])("bypasses reads and writes after starting with TTL %i", async (ttl) => {
    const query = `cache disable from ${ttl}`;
    expectResult(await search(query, ttl), "original", 1);
    if (ttl > 0) {
      expectResult(await search(query, ttl), "original", 1, true);
    }

    for (const freshBody of ["fresh", "newest"]) {
      body = freshBody;
      expectResult(await search(query, 0), freshBody, freshBody === "fresh" ? 2 : 3, false);
    }
    body = "reenabled";
    expectResult(await search(query, 15), ttl > 0 ? "original" : "reenabled", ttl > 0 ? 3 : 4);
  });

  it("honors a shorter reader TTL and does not extend the replacement entry's expiry", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const query = "shorter cache TTL";
    await search(query, 15);
    for (const [elapsed, ttl, content, calls, cached] of [
      [59_999, 1, "original", 1, true],
      [1, 1, "fresh", 2, false],
      [60_001, 15, "expired", 3, false],
    ] as const) {
      now += elapsed;
      body = content;
      expectResult(await search(query, ttl), content, calls, cached);
    }
  });
});

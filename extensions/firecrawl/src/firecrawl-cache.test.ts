import { createServer, type Server } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFirecrawlTools } from "./firecrawl-tools.test-support.js";

describe("Firecrawl search cache", () => {
  let server: Server;
  let baseUrl: string;
  let networkCalls: number;
  let body: string;
  let resolveCredentialBody: ((authorization: string) => Promise<string>) | undefined;
  let authorizations: string[];

  beforeEach(async () => {
    networkCalls = 0;
    body = "original";
    resolveCredentialBody = undefined;
    authorizations = [];
    server = createServer((request, response) => {
      networkCalls += 1;
      const authorization = request.headers.authorization ?? "";
      authorizations.push(authorization);
      void Promise.resolve(resolveCredentialBody?.(authorization) ?? body).then(
        (content) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              success: true,
              data: [{ url: `https://example.com/${content}`, title: content }],
            }),
          );
        },
        (error: unknown) => {
          response.destroy(new Error("credential response failed", { cause: error }));
        },
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected a loopback TCP address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  });

  async function search(
    query: string,
    cacheTtlMinutes: number,
    apiKey = "firecrawl-cache-test-key",
  ) {
    const config: OpenClawConfig = {
      tools: { web: { search: { cacheTtlMinutes } } },
      plugins: {
        entries: {
          firecrawl: { config: { webSearch: { baseUrl, apiKey } } },
        },
      },
    };
    const tool = captureFirecrawlTools(config)("firecrawl_search");
    return (await tool.execute("cache-test", { query })).details;
  }

  it("keeps interleaved account results and warm reuse scoped to their credentials", async () => {
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    resolveCredentialBody = async (authorization) => {
      if (authorization === "Bearer firecrawl-account-a") {
        started.resolve();
        await finish.promise;
        return "account-a";
      }
      return "account-b";
    };
    const query = "credential-scoped Firecrawl result reuse";
    const first = search(query, 15, "firecrawl-account-a");
    try {
      await started.promise;
      expect(await search(query, 15, "firecrawl-account-b")).toMatchObject({
        results: [{ url: "https://example.com/account-b" }],
      });
      finish.resolve();
      expect(await first).toMatchObject({ results: [{ url: "https://example.com/account-a" }] });
      for (const account of ["b", "a"]) {
        expect(await search(query, 15, `firecrawl-account-${account}`)).toMatchObject({
          results: [{ url: `https://example.com/account-${account}` }],
          cached: true,
        });
      }
      expect(networkCalls).toBe(2);
      expect(authorizations).toEqual(["Bearer firecrawl-account-a", "Bearer firecrawl-account-b"]);
    } finally {
      finish.resolve();
      await first;
    }
  });

  it.each([0, 15])("bypasses reads and writes after starting with TTL %i", async (initialTtl) => {
    const query = `cache disable from ${initialTtl}`;
    expect(await search(query, initialTtl)).toMatchObject({
      results: [{ url: "https://example.com/original" }],
    });
    if (initialTtl > 0) {
      expect(await search(query, initialTtl)).toMatchObject({ cached: true });
    }
    expect(networkCalls).toBe(1);

    for (const freshBody of ["fresh", "newest"]) {
      body = freshBody;
      const result = await search(query, 0);
      expect(result).toMatchObject({ results: [{ url: `https://example.com/${freshBody}` }] });
      expect(result).not.toHaveProperty("cached");
    }
    expect(networkCalls).toBe(3);

    // Disabled requests must neither replace an existing entry nor populate an empty cache.
    body = "reenabled";
    expect(await search(query, 15)).toMatchObject({
      results: [{ url: `https://example.com/${initialTtl > 0 ? "original" : "reenabled"}` }],
    });
    expect(networkCalls).toBe(initialTtl > 0 ? 3 : 4);
  });

  it("honors a shorter reader TTL and does not extend the replacement entry's expiry", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const query = "shorter cache TTL";
    await search(query, 15);
    now += 59_999;
    expect(await search(query, 1)).toMatchObject({ cached: true });
    expect(networkCalls).toBe(1);

    now += 1;
    body = "fresh";
    const shortened = await search(query, 1);
    expect(shortened).toMatchObject({ results: [{ url: "https://example.com/fresh" }] });
    expect(shortened).not.toHaveProperty("cached");
    expect(networkCalls).toBe(2);

    now += 60_001;
    body = "expired";
    const expired = await search(query, 15);
    expect(expired).toMatchObject({ results: [{ url: "https://example.com/expired" }] });
    expect(expired).not.toHaveProperty("cached");
    expect(networkCalls).toBe(3);
  });
});

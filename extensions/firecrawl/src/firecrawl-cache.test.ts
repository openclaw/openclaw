import { createServer, type Server } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFirecrawlTools } from "./firecrawl-tools.test-support.js";

describe("Firecrawl search cache", () => {
  let server: Server;
  let baseUrl: string;
  let body: string;
  let resolveCredentialBody: ((authorization: string) => Promise<string>) | undefined;
  let authorizations: string[];

  beforeEach(async () => {
    body = "original";
    resolveCredentialBody = undefined;
    authorizations = [];
    server = createServer((request, response) => {
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

  async function search(query: string, cacheTtlMinutes: number, apiKey = "cache-test-key") {
    const webSearch = { baseUrl, apiKey };
    const config: OpenClawConfig = {
      tools: { web: { search: { cacheTtlMinutes } } },
      plugins: { entries: { firecrawl: { config: { webSearch } } } },
    };
    const tool = captureFirecrawlTools(config)("firecrawl_search");
    return (await tool.execute("cache-test", { query })).details;
  }

  function expectResult(result: unknown, content: string, calls: number, cached?: boolean) {
    expect(result).toMatchObject({ results: [{ url: `https://example.com/${content}` }] });
    expect(authorizations).toHaveLength(calls);
    if (cached === true) {
      expect(result).toMatchObject({ cached: true });
    } else if (cached === false) {
      expect(result).not.toHaveProperty("cached");
    }
  }

  it("keeps interleaved account results and warm reuse scoped to their credentials", async () => {
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    resolveCredentialBody = async (authorization) => {
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

  it.each([0, 15])("bypasses reads and writes after starting with TTL %i", async (initialTtl) => {
    const query = `cache disable from ${initialTtl}`;
    expectResult(await search(query, initialTtl), "original", 1);
    if (initialTtl > 0) {
      expectResult(await search(query, initialTtl), "original", 1, true);
    }

    for (const freshBody of ["fresh", "newest"]) {
      body = freshBody;
      expectResult(await search(query, 0), freshBody, freshBody === "fresh" ? 2 : 3, false);
    }

    // Disabled requests must neither replace an existing entry nor populate an empty cache.
    body = "reenabled";
    expectResult(
      await search(query, 15),
      initialTtl > 0 ? "original" : "reenabled",
      initialTtl > 0 ? 3 : 4,
    );
  });

  it("honors a shorter reader TTL and does not extend the replacement entry's expiry", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const query = "shorter cache TTL";
    await search(query, 15);
    now += 59_999;
    expectResult(await search(query, 1), "original", 1, true);

    now += 1;
    body = "fresh";
    expectResult(await search(query, 1), "fresh", 2, false);

    now += 60_001;
    body = "expired";
    expectResult(await search(query, 15), "expired", 3, false);
  });
});

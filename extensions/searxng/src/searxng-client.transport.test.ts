import { createServer, type Server } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testing } from "./searxng-client.js";
import { createSearxngWebSearchProvider } from "./searxng-search-provider.js";

const servers = new Set<Server>();

function createTool(baseUrl: string, cacheTtlMinutes = 15) {
  const searchConfig = { cacheTtlMinutes };
  return expectDefined(
    createSearxngWebSearchProvider().createTool({
      config: {
        tools: { web: { search: searchConfig } },
        plugins: { entries: { searxng: { config: { webSearch: { baseUrl } } } } },
      },
      searchConfig,
    }),
    "SearXNG search tool",
  );
}

async function listen(server: Server): Promise<string> {
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP listener address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  testing.SEARXNG_SEARCH_CACHE.clear();
  await Promise.all([...servers].map(closeServer));
  servers.clear();
});

describe("searxng real transport", () => {
  it.each([0, 1])(
    "applies the current %s-minute provider TTL to cached results",
    async (cacheTtlMinutes) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
      let requests = 0;
      const baseUrl = await listen(
        createServer((_request, response) => {
          requests += 1;
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              results: [{ title: `Result ${requests}`, url: `https://example.com/${requests}` }],
            }),
          );
        }),
      );
      const search = (ttl: number) =>
        createTool(baseUrl, ttl).execute(
          { query: "current search TTL" },
          { signal: new AbortController().signal },
        );

      const original = await search(15);
      expect(await search(15)).toEqual({ ...original, cached: true });
      expect(requests).toBe(1);

      if (cacheTtlMinutes > 0) {
        clock.mockReturnValue(Date.now() + 60_000);
      }
      const fresh = await search(cacheTtlMinutes);
      expect(fresh.cached).toBeUndefined();
      expect(fresh.results).toEqual([expect.objectContaining({ url: "https://example.com/2" })]);
      expect(requests).toBe(2);

      if (cacheTtlMinutes === 0) {
        const next = await search(0);
        expect(next.cached).toBeUndefined();
        expect(next.results).toEqual([expect.objectContaining({ url: "https://example.com/3" })]);
        expect(await search(15)).toEqual({ ...original, cached: true });
        expect(requests).toBe(3);
      } else {
        expect(await search(1)).toEqual({ ...fresh, cached: true });
        expect(requests).toBe(2);
      }
    },
  );

  it("aborts a provider's stalled response body and closes the request", async () => {
    const requestStarted = Promise.withResolvers<void>();
    const clientClosed = Promise.withResolvers<void>();
    const server = createServer((request, response) => {
      request.socket.once("close", () => clientClosed.resolve());
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"results":[');
      response.flushHeaders();
      requestStarted.resolve();
    });
    const baseUrl = await listen(server);
    const controller = new AbortController();
    const pending = createTool(baseUrl).execute(
      { query: "stalled response", categories: "general" },
      { signal: controller.signal },
    );

    await requestStarted.promise;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(clientClosed.promise).resolves.toBeUndefined();
  });
});

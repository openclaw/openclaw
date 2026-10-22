import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type RequestListener, type Server } from "node:http";
import { promisify } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSearxngWebSearchProvider } from "./searxng-search-provider.js";

let server: Server, baseUrl: string, requests: number, respond: RequestListener;
beforeEach(async () => {
  requests = 0;
  respond = (_request, response) => {
    const results = [{ title: "Result", url: `https://example.com/${requests}` }];
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ results }));
  };
  server = createServer((request, response) => {
    requests++;
    respond(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string", "Expected a TCP listener address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  server.closeAllConnections();
  await promisify(server.close.bind(server))();
});

function createTool(
  cacheTtlMinutes = 15,
  defaults: { maxResults?: number; timeoutSeconds?: number } = {},
) {
  const provider = createSearxngWebSearchProvider();
  const config = {
    tools: { web: { search: { cacheTtlMinutes, ...defaults } } },
    plugins: { entries: { searxng: { config: { webSearch: { baseUrl } } } } },
  };
  return expectDefined(provider.createTool({ config }), "SearXNG search tool");
}

it.each([0, 1])("applies the current %s-minute provider TTL to cached results", async (ttl) => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  const search = async (minutes: number, count: number, cached?: Record<string, unknown>) => {
    const result = await createTool(minutes).execute({ query: `current TTL ${ttl}` });
    expect(requests).toBe(count);
    expect(result.cached).toBe(cached ? true : undefined);
    if (cached) {
      expect(result).toEqual({ ...cached, cached: true });
    } else {
      expect(result.results).toEqual([
        expect.objectContaining({ url: `https://example.com/${count}` }),
      ]);
    }
    return result;
  };
  const original = await search(15, 1);
  await search(15, 1, original);
  if (ttl > 0) {
    clock.mockReturnValue(Date.now() + 60_000);
  }
  const fresh = await search(ttl, 2);
  if (ttl === 0) {
    await search(0, 3);
    await search(15, 3, original);
  } else {
    await search(1, 2, fresh);
  }
});

it("aborts a provider's stalled response body and closes the request", async () => {
  const requestStarted = Promise.withResolvers<void>();
  const clientClosed = Promise.withResolvers<void>();
  respond = (request, response) => {
    request.socket.once("close", () => clientClosed.resolve());
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"results":[');
    response.flushHeaders();
    requestStarted.resolve();
  };
  const controller = new AbortController();
  const pending = createTool().execute(
    { query: "stalled response", categories: "general" },
    { signal: controller.signal },
  );
  await requestStarted.promise;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await expect(clientClosed.promise).resolves.toBeUndefined();
});

it("keeps configured and explicit result counts separate in the cache", async () => {
  respond = (_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        results: [1, 2, 3, 4].map((id) => ({
          title: `Result ${id}`,
          url: `https://example.com/${id}`,
        })),
      }),
    );
  };
  const args = { query: "configured count" };
  const one = await createTool(15, { maxResults: 1 }).execute(args);
  expect(one.results).toHaveLength(1);
  expect(await createTool(15, { maxResults: 1 }).execute(args)).toEqual({ ...one, cached: true });
  expect(requests).toBe(1);
  const three = await createTool(15, { maxResults: 3 }).execute(args);
  expect(three.results).toHaveLength(3);
  expect(three.cached).toBeUndefined();
  expect(requests).toBe(2);
  const explicit = await createTool(15, { maxResults: 1 }).execute({ ...args, count: 2 });
  expect(explicit.results).toHaveLength(2);
  expect(requests).toBe(3);
});

it("aborts at the configured deadline but permits a longer configured timeout", async () => {
  const closed = Promise.withResolvers<void>();
  respond = (_request, response) => {
    // Exercise the native HTTP/AbortSignal deadline; fake timers do not drive socket I/O.
    const timer = setTimeout(() => {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({ results: [{ title: "Result", url: "https://example.com/ok" }] }),
      );
    }, 2_000);
    response.once("close", () => {
      clearTimeout(timer);
      closed.resolve();
    });
  };
  const tool = createTool(0, { timeoutSeconds: 1 });
  await expect(tool.execute({ query: "short deadline" })).rejects.toMatchObject({
    name: "TimeoutError",
  });
  await closed.promise;
  const allowed = await createTool(0, { timeoutSeconds: 3 }).execute({ query: "longer budget" });
  expect(allowed.results).toHaveLength(1);
  expect(requests).toBe(2);
});

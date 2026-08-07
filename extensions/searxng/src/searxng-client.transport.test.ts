import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSearxngSearch, testing } from "./searxng-client.js";
import { createSearxngWebSearchProvider } from "./searxng-search-provider.js";

const servers = new Set<Server>();

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
  vi.unstubAllEnvs();
  testing.SEARXNG_SEARCH_CACHE.clear();
  await Promise.all([...servers].map(closeServer));
  servers.clear();
});

describe("searxng real transport", () => {
  it("reads JSON results from a loopback endpoint", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          results: [
            {
              title: "OpenClaw",
              url: "https://docs.openclaw.ai/",
              content: "OpenClaw documentation",
            },
          ],
        }),
      );
    });
    const baseUrl = await listen(server);

    await expect(
      runSearxngSearch({
        baseUrl,
        query: "openclaw",
        categories: "general",
      }),
    ).resolves.toMatchObject({
      provider: "searxng",
      count: 1,
      results: [{ url: "https://docs.openclaw.ai/" }],
    });
  });

  it("enforces env provider allowlists before selecting a transport endpoint", async () => {
    let configuredRequests = 0;
    let ambientRequests = 0;
    const configuredServer = createServer((_request, response) => {
      configuredRequests += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          results: [
            {
              title: "Configured endpoint",
              url: "https://example.com/configured",
              content: "Allowed provider result",
            },
          ],
        }),
      );
    });
    const ambientServer = createServer((_request, response) => {
      ambientRequests += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ results: [] }));
    });
    const configuredBaseUrl = await listen(configuredServer);
    const ambientBaseUrl = await listen(ambientServer);
    vi.stubEnv("CUSTOM_SEARXNG_BASE_URL", configuredBaseUrl);
    vi.stubEnv("SEARXNG_BASE_URL", ambientBaseUrl);

    const createConfig = (allowlist: string[]) =>
      ({
        secrets: {
          providers: {
            "searxng-env": {
              source: "env",
              allowlist,
            },
          },
        },
        plugins: {
          entries: {
            searxng: {
              config: {
                webSearch: {
                  baseUrl: {
                    source: "env",
                    provider: "searxng-env",
                    id: "CUSTOM_SEARXNG_BASE_URL",
                  },
                },
              },
            },
          },
        },
      }) as never;
    const provider = createSearxngWebSearchProvider();
    const allowedTool = provider.createTool({
      config: createConfig(["CUSTOM_SEARXNG_BASE_URL"]),
    } as never);
    if (!allowedTool) {
      throw new Error("Expected SearXNG tool for allowed provider proof");
    }

    const allowedResult = await allowedTool.execute({ query: "allowed provider" });
    expect(allowedResult).toMatchObject({
      provider: "searxng",
      count: 1,
      results: [{ url: "https://example.com/configured" }],
    });
    expect(configuredRequests).toBe(1);
    expect(ambientRequests).toBe(0);

    const deniedTool = provider.createTool({
      config: createConfig(["OTHER_SEARXNG_BASE_URL"]),
    } as never);
    if (!deniedTool) {
      throw new Error("Expected SearXNG tool for denied provider proof");
    }
    await expect(deniedTool.execute({ query: "denied provider" })).rejects.toThrow(
      "Configured SearXNG base URL is unavailable or invalid.",
    );
    expect(configuredRequests).toBe(1);
    expect(ambientRequests).toBe(0);
    console.info(
      "SEARXNG_PROVIDER_POLICY_PROOF",
      JSON.stringify({
        allowed: { configuredRequests: 1, ambientRequests: 0, resultCount: 1 },
        denied: { configuredRequests: 0, ambientRequests: 0, failedBeforeFetch: true },
        endpoints: "[redacted-loopback]",
      }),
    );
  });

  it("aborts a stalled response body and closes the request", async () => {
    let resolveRequestStarted: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      resolveRequestStarted = resolve;
    });
    let resolveClientClosed: (() => void) | undefined;
    const clientClosed = new Promise<void>((resolve) => {
      resolveClientClosed = resolve;
    });
    const server = createServer((request, response) => {
      request.socket.once("close", () => resolveClientClosed?.());
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"results":[');
      response.flushHeaders();
      resolveRequestStarted?.();
    });
    const baseUrl = await listen(server);
    const controller = new AbortController();
    const pending = runSearxngSearch({
      baseUrl,
      query: "stalled response",
      categories: "general",
      timeoutSeconds: 30,
      signal: controller.signal,
    });

    await requestStarted;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(clientClosed).resolves.toBeUndefined();
  });
});

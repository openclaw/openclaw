import { createServer, type RequestListener, type Server } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { setImmediate } from "node:timers/promises";
import * as ssrf from "openclaw/plugin-sdk/ssrf-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback as bindLoopbackServer } from "../test-support/hanging-loopback-server.js";
import { fetchClawRouterUsage } from "./usage.js";

const fetchWithSsrFGuard = ssrf.fetchWithSsrFGuard;
const runningServers: Server[] = [];
const runningSockets = new Set<Duplex>();
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"].flatMap((key) => [
  key,
  key.toLowerCase(),
]);

function trackSocket(socket: Duplex): void {
  runningSockets.add(socket);
  socket.once("close", () => runningSockets.delete(socket));
}

async function listenOnLoopback(server: Server): Promise<number> {
  const port = await bindLoopbackServer(server);
  runningServers.push(server);
  return port;
}

async function startUsageServer(handler: RequestListener) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method ?? "GET"} ${req.url ?? "/"}`);
    handler(req, res);
  });
  const port = await listenOnLoopback(server);
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

async function startConnectProxy(): Promise<{ proxyUrl: string; connects: string[] }> {
  const connects: string[] = [];
  const server = createServer();
  server.on("connect", (req, clientSocket, head) => {
    const target = req.url;
    if (!target) {
      clientSocket.destroy();
      return;
    }
    connects.push(target);
    trackSocket(clientSocket);
    const targetUrl = new URL(`http://${target}`);
    const targetSocket = connect(Number(targetUrl.port), targetUrl.hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        targetSocket.write(head);
      }
      clientSocket.pipe(targetSocket).pipe(clientSocket);
    });
    trackSocket(targetSocket);
    targetSocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => targetSocket.destroy());
  });
  const port = await listenOnLoopback(server);
  return { proxyUrl: `http://127.0.0.1:${port}`, connects };
}

beforeEach(() => {
  for (const key of PROXY_ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
});

afterEach(async () => {
  for (const socket of runningSockets) {
    socket.destroy();
  }
  runningSockets.clear();
  await Promise.all(runningServers.splice(0).map((server) => server[Symbol.asyncDispose]()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function mockFetchGuard(response: Response, release: () => Promise<void> = async () => undefined) {
  return vi
    .spyOn(ssrf, "fetchWithSsrFGuard")
    .mockImplementation(async ({ url }) => ({ response, finalUrl: url, release }));
}

function fetchUsage(
  params: Omit<Parameters<typeof fetchClawRouterUsage>[0], "token" | "timeoutMs">,
) {
  return fetchClawRouterUsage({ token: "proxy-key", timeoutMs: 5000, ...params });
}

function fetchResponse(response: Response) {
  mockFetchGuard(response);
  return fetchUsage({});
}

describe("ClawRouter usage", () => {
  it("maps the managed monthly budget and usage totals", async () => {
    const resetAt = Date.UTC(2026, 7, 1);
    mockFetchGuard(
      Response.json({
        budget: {
          configured: true,
          windowKey: "default/test-policy/2026-07",
          limitMicros: 100_000_000,
          spentMicros: 25_000_000,
        },
        usage: {
          summary: { requestCount: 12, totalTokens: 34_567, actualCostMicros: 25_000_000 },
        },
      }),
    );

    const snapshot = await fetchUsage({ baseUrl: "https://clawrouter.example/v1" });

    expect(snapshot).toEqual({
      provider: "clawrouter",
      displayName: "ClawRouter",
      windows: [{ label: "Monthly budget", usedPercent: 25, resetAt }],
      billing: [{ type: "budget", used: 25, limit: 100, unit: "USD", period: "month", resetAt }],
      summary: "12 requests · 34,567 tokens · $25.00 used",
      plan: "Managed monthly budget",
    });
  });

  it("does not coerce numeric strings from the usage boundary", async () => {
    const snapshot = await fetchResponse(
      Response.json({
        budget: { configured: true, limitMicros: "1000000", spentMicros: "500000" },
        usage: { summary: { requestCount: "2", totalTokens: "300", actualCostMicros: "500000" } },
      }),
    );

    expect([snapshot.windows, snapshot.billing, snapshot.summary]).toEqual([
      [],
      undefined,
      undefined,
    ]);
  });

  it("reports malformed JSON as a malformed usage response", async () => {
    expect(await fetchResponse(new Response('{"budget":'))).toMatchObject({
      windows: [],
      error: "Malformed usage response",
    });
  });

  it("releases a rejected response while a capture clone retains its body", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { status: 503 });
    const capture = response.clone();
    const release = vi.fn(async () => {
      await capture.body?.cancel();
    });
    mockFetchGuard(response, release);
    const outcome = fetchUsage({}).catch((error: unknown) => error);

    try {
      await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
      expect(await outcome).toEqual(new Error("ClawRouter usage request failed (HTTP 503)"));
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      // Settle both native tee branches even when the release-order assertion fails.
      await capture.body?.cancel();
      await outcome;
    }
  });

  it("observes peer closure when a real loopback server returns non-OK", async () => {
    const { promise: responseClosed, resolve: onResponseClosed } = Promise.withResolvers<void>();
    const { baseUrl, requests } = await startUsageServer((_req, res) => {
      res.once("close", onResponseClosed);
      res.writeHead(503, { "content-type": "text/plain" });
      res.write("service unavailable");
    });

    await expect(fetchUsage({ baseUrl })).rejects.toThrow(
      "ClawRouter usage request failed (HTTP 503)",
    );

    expect(requests).toEqual(["GET /v1/usage"]);
    await responseClosed;
  });

  it("bounds successful usage response bodies", async () => {
    const response = new Response("x".repeat(1024 * 1024 + 1));
    await expect(fetchResponse(response)).rejects.toThrow("ClawRouter usage response exceeds");
  });

  it("bounds a native stalled body after headers and releases its request", async ({ signal }) => {
    const closed = Promise.withResolvers<void>();
    await withServer(
      (_request, response) => {
        response.once("close", closed.resolve);
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"budget":');
      },
      async (baseUrl) => {
        const headersReady = Promise.withResolvers<void>();
        const released = vi.fn();
        vi.spyOn(ssrf, "fetchWithSsrFGuard").mockImplementation(async (params) => {
          const guarded = await fetchWithSsrFGuard(params).catch((error: unknown) => {
            headersReady.reject(error);
            throw error;
          });
          headersReady.resolve();
          return {
            ...guarded,
            release: async () => {
              await guarded.release();
              released();
            },
          };
        });
        const controller = new AbortController();
        // Keep HTTP/body reads native and advance only the request deadline clock.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const outcome = fetchClawRouterUsage({
          token: "synthetic-proxy-key",
          baseUrl,
          timeoutMs: 1,
          signal: controller.signal,
        }).catch((error: unknown) => error);
        try {
          await withinTest(headersReady.promise, signal);
          await setImmediate();
          await vi.advanceTimersByTimeAsync(1);
          expect(await withinTest(outcome, signal)).toMatchObject({
            message: expect.stringMatching(/abort|timed out/i),
          });
          expect(released).toHaveBeenCalledOnce();
          await withinTest(closed.promise, signal);
        } finally {
          controller.abort();
          vi.useRealTimers();
          await outcome;
        }
      },
    );
  });

  it("preserves provider usage routing through the env proxy", async () => {
    const { baseUrl } = await startUsageServer((req, res) => {
      expect(req.headers.authorization).toBe("Bearer proxy-key");
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(
        JSON.stringify({
          budget: { configured: false, ledger: "unmetered" },
          usage: { summary: { requestCount: 2, totalTokens: 8, actualCostMicros: 0 } },
        }),
      );
    });
    const { proxyUrl, connects } = await startConnectProxy();
    process.env.HTTP_PROXY = proxyUrl;

    const snapshot = await fetchUsage({ baseUrl });

    expect(snapshot.summary).toBe("2 requests · 8 tokens · $0.00 used");
    expect(connects).toEqual([new URL(baseUrl).host]);
  });

  it("blocks private-network redirects before a second proxied request", async () => {
    const { baseUrl, requests } = await startUsageServer((_req, res) => {
      res.writeHead(302, { Location: "http://10.0.0.1:9/v1/usage" });
      res.end();
    });
    const { proxyUrl, connects } = await startConnectProxy();
    process.env.HTTP_PROXY = proxyUrl;

    await expect(fetchUsage({ baseUrl })).rejects.toThrow(/private|internal|blocked/i);
    expect(requests).toEqual(["GET /v1/usage"]);
    expect(connects).toEqual([new URL(baseUrl).host]);
  });
});

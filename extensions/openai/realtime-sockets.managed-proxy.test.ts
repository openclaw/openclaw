import http, { createServer, type ClientRequest, type RequestOptions } from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import { createNodeProxyAgent } from "openclaw/plugin-sdk/fetch-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../test-support/hanging-loopback-server.js";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import { createOpenAIQuicksilverBrowserSessionBroker } from "./realtime-quicksilver-session.js";
import {
  createCallResponse,
  createRequest,
  createResponseHarness,
} from "./realtime-quicksilver.test-helpers.js";

const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  try {
    for (const close of closers.splice(0).toReversed()) {
      await close();
    }
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

// Gateway-isolate sockets get no agent of their own: they rely on the managed
// proxy hooks below, which Bun's built-in adapter for a bare `ws` import skips.
// The realtime voice bridge runs against the real hooks in
// src/infra/net/proxy/managed-proxy-openai-realtime.test.ts; these sideband paths
// are not on the plugin's public surface.
describe("OpenAI realtime sidebands under the managed proxy", () => {
  it("offers the browser session sideband only to the managed proxy", async () => {
    const proxy = await startRefusingProxy();
    routeNodeHttpThroughProxy(proxy.url);
    const realtime = createOpenAIQuicksilverBrowserSessionBroker(
      {
        getConfig: () => ({}),
        logger: { debug: vi.fn(), warn: vi.fn() },
        fetchImpl: vi.fn(async () => createCallResponse()),
      },
      openAIRealtimeHost,
    );
    closers.push(() => realtime.cleanup());
    const reservation = await realtime.broker.createBrowserSession(
      {
        providerConfig: {},
        model: "gpt-live-test-canary",
        runAgentConsult: vi.fn(async () => ({ text: "Done" })),
      },
      { type: "api-key", token: "platform-key" },
    );
    if (reservation.transport !== "webrtc") {
      throw new Error("Expected WebRTC reservation");
    }
    const response = createResponseHarness();

    await realtime.handler(createRequest({ token: reservation.clientSecret }), response.res);

    // A refused tunnel fails the offer; there is no direct sideband retry.
    expect(response.res.statusCode).toBe(502);
    expect(proxy.connects.length).toBeGreaterThan(0);
    expect(new Set(proxy.connects)).toEqual(new Set(["api.openai.com:443"]));
  }, 15_000);

  it("offers the gateway relay sideband only to the managed proxy", async () => {
    const proxy = await startRefusingProxy();
    routeNodeHttpThroughProxy(proxy.url);
    const bridge = new OpenAIQuicksilverGatewayBridge(
      {
        providerConfig: {},
        model: "gpt-live-test-canary",
        audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
        logger: { debug: vi.fn(), warn: vi.fn() },
        runAgentConsult: vi.fn(async () => ({ text: "done" })),
        resolveAuth: async () => ({ type: "oauth", token: "oauth-token", accountId: "account-1" }),
        createPeer: vi.fn(async () => ({
          createOffer: vi.fn(async () => "v=offer\r\n"),
          applyAnswer: vi.fn(async () => undefined),
          adoptPendingAudio: vi.fn(),
          sendAudio: vi.fn(),
          close: vi.fn(),
        })),
        fetchImpl: vi.fn<typeof fetch>(async () =>
          createCallResponse("v=answer\r\n", "rtc_bridge"),
        ),
      },
      openAIRealtimeHost,
    );
    closers.push(() => bridge.close());

    await expect(bridge.connect()).rejects.toThrow();

    expect(proxy.connects.length).toBeGreaterThan(0);
    expect(new Set(proxy.connects)).toEqual(new Set(["api.openai.com:443"]));
  }, 15_000);
});

// Mirrors the managed proxy's Gateway-isolate hooks: every node:http(s) request
// gets a proxy agent, and the caller's direct createConnection is dropped.
function routeNodeHttpThroughProxy(proxyUrl: string): void {
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", undefined);
  for (const [module, protocol] of [
    [http, "http"],
    [https, "https"],
  ] as const) {
    const request = module.request;
    vi.spyOn(module, "request").mockImplementation(((
      options: RequestOptions,
      callback?: (response: http.IncomingMessage) => void,
    ): ClientRequest => {
      const agent = createNodeProxyAgent({ mode: "explicit", proxyUrl, protocol });
      const { createConnection: _direct, ...routed } = options;
      const routedRequest = request({ ...routed, agent }, callback);
      routedRequest.once("close", () => agent.destroy());
      return routedRequest;
    }) as typeof module.request);
  }
}

// Refuses every tunnel, so a sideband can only fail; the CONNECT targets show where it dialed.
async function startRefusingProxy() {
  const connects: string[] = [];
  const server = createServer((_request, response) => response.writeHead(405).end());
  server.on("connect", (request, client: Socket) => {
    connects.push(request.url ?? "");
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  const port = await listenOnLoopback(server);
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { connects, url: `http://127.0.0.1:${port}` };
}

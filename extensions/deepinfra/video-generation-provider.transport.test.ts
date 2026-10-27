import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { buffer as consumeBuffer } from "node:stream/consumers";
import { withEnvAsync, withServer } from "openclaw/plugin-sdk/test-env";
import { afterAll, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../test-support/hanging-loopback-server.js";
import { buildDeepInfraVideoGenerationProvider } from "./video-generation-provider.js";
import { WEBM_VIDEO } from "./video-generation.test-support.js";

const video = { buffer: WEBM_VIDEO, mimeType: "video/webm", fileName: "video-1.webm" };

vi.hoisted(() => vi.resetModules());
vi.unmock("openclaw/plugin-sdk/provider-http");

// mock-isolation: Resolve synthetic credentials without loading the live auth store.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: vi.fn(async () => ({
    apiKey: "test",
    source: "profile",
    mode: "api-key",
  })),
}));

type CapturedRequest = Pick<IncomingMessage, "headers" | "method" | "url"> & { body: string };

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/provider-auth-runtime");
  vi.resetModules();
});

function createDeepInfraHandler(requests: CapturedRequest[], buffer = WEBM_VIDEO) {
  return (request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: (await consumeBuffer(request)).toString("utf8"),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "local-request",
          status: "succeeded",
          data: [
            {
              url: `data:video/webm;base64,${buffer.toString("base64")}`,
            },
          ],
        }),
      );
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  };
}

async function startConnectProxy(upstreamBaseUrl: string) {
  const upstreamUrl = new URL(upstreamBaseUrl);
  const upstreamPort = Number(upstreamUrl.port);
  const connectTargets: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => {
    response.writeHead(502);
    response.end("CONNECT required");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (request, clientSocket, head) => {
    connectTargets.push(request.url ?? "");
    const upstreamSocket = connect(upstreamPort, upstreamUrl.hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });
    sockets.add(upstreamSocket);
    upstreamSocket.on("close", () => sockets.delete(upstreamSocket));
    clientSocket.on("error", () => upstreamSocket.destroy());
    upstreamSocket.on("error", () => clientSocket.destroy());
  });
  const port = await listenOnLoopback(server);
  return {
    connectTargets,
    proxyUrl: `http://127.0.0.1:${port}`,
    [Symbol.asyncDispose]: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await server[Symbol.asyncDispose]();
    },
  };
}

type RequestPolicy = {
  allowPrivateNetwork?: boolean;
  headers?: Record<string, string>;
  proxy?: { mode: "env-proxy" };
};

async function generateLocalVideo(baseUrl: string, request?: RequestPolicy) {
  return await buildDeepInfraVideoGenerationProvider().generateVideo({
    provider: "deepinfra",
    model: "deepinfra/Pixverse/Pixverse-T2V",
    prompt: "transport proof",
    cfg: { models: { providers: { deepinfra: { baseUrl, models: [], request } } } } as never,
    timeoutMs: 5_000,
  });
}

describe("deepinfra video generation provider transport", () => {
  it.each([
    { label: "video bytes", buffer: WEBM_VIDEO, valid: true },
    { label: "non-video bytes", buffer: Buffer.from("not a video"), valid: false },
  ])("forwards request policy and validates $label", async ({ buffer, valid }) => {
    const requests: CapturedRequest[] = [];
    await withServer(createDeepInfraHandler(requests, buffer), async (baseUrl) => {
      const result = generateLocalVideo(`${baseUrl}/v1/openai`, {
        allowPrivateNetwork: true,
        headers: { "X-DeepInfra-Trace": "transport-proof" },
      });
      if (valid) {
        expect((await result).videos).toEqual([video]);
      } else {
        await expect(result).rejects.toThrow("DeepInfra video response: malformed video response");
      }
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        method: "POST",
        url: "/v1/openai/videos",
        headers: { "x-deepinfra-trace": "transport-proof" },
      });
      expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
        prompt: "transport proof",
      });
    });
  });

  it("routes configured env proxy policy through a real CONNECT tunnel", async () => {
    const requests: CapturedRequest[] = [];
    await withServer(createDeepInfraHandler(requests), async (baseUrl) => {
      await using proxy = await startConnectProxy(baseUrl);
      await withEnvAsync(
        {
          HTTP_PROXY: proxy.proxyUrl,
          http_proxy: undefined,
          HTTPS_PROXY: undefined,
          https_proxy: undefined,
          NO_PROXY: undefined,
          no_proxy: undefined,
        },
        () =>
          generateLocalVideo(`${baseUrl}/v1/openai`, {
            allowPrivateNetwork: true,
            proxy: { mode: "env-proxy" },
          }),
      );

      expect(proxy.connectTargets).toEqual([new URL(baseUrl).host]);
      expect(requests).toHaveLength(1);
    });
  });

  it.each([
    ["default", undefined],
    ["explicit false", { allowPrivateNetwork: false }],
  ])("blocks loopback before transport with %s private-network policy", async (_label, request) => {
    const requests: CapturedRequest[] = [];
    await withServer(createDeepInfraHandler(requests), async (baseUrl) => {
      await expect(generateLocalVideo(`${baseUrl}/v1/openai`, request)).rejects.toThrow(
        expect.objectContaining({
          name: "SsrFBlockedError",
          message: expect.stringContaining("private/internal/special-use IP address"),
        }),
      );
      expect(requests).toHaveLength(0);
    });
  });
});

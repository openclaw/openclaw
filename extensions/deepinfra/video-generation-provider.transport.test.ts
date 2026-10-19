import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { text } from "node:stream/consumers";
import { promisify } from "node:util";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { withEnvAsync, withServer } from "openclaw/plugin-sdk/test-env";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildDeepInfraVideoGenerationProvider } from "./video-generation-provider.js";
import { WEBM_VIDEO } from "./video-generation.test-support.js";

vi.hoisted(() => vi.resetModules());
vi.unmock("openclaw/plugin-sdk/provider-http");

const resolveApiKeyForProviderMock = vi.hoisted(() =>
  vi.fn(async () => ({
    apiKey: "test",
    source: "profile",
    mode: "api-key",
  })),
);

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

type CapturedRequest = Pick<IncomingMessage, "headers" | "method" | "url"> & { body: string };

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/provider-auth-runtime");
  vi.resetModules();
});

function createDeepInfraHandler(requests: CapturedRequest[]) {
  return (request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: await text(request),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "local-request",
          status: "succeeded",
          data: [{ url: `data:video/webm;base64,${WEBM_VIDEO.toString("base64")}` }],
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
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("CONNECT proxy did not bind to a TCP port");
  }
  return {
    connectTargets,
    proxyUrl: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await promisify(server.close.bind(server))();
    },
  };
}

async function generateLocalVideo(baseUrl: string, request?: ModelProviderConfig["request"]) {
  return await buildDeepInfraVideoGenerationProvider().generateVideo({
    provider: "deepinfra",
    model: "deepinfra/Pixverse/Pixverse-T2V",
    prompt: "transport proof",
    cfg: {
      models: {
        providers: {
          deepinfra: {
            baseUrl: `${baseUrl}/v1/openai`,
            models: [],
            ...(request ? { request } : {}),
          },
        },
      },
    } as never,
    timeoutMs: 5_000,
  });
}

describe("deepinfra video generation provider transport", () => {
  it("forwards configured request policy through the real local video transport path", async () => {
    const requests: CapturedRequest[] = [];
    await withServer(createDeepInfraHandler(requests), async (baseUrl) => {
      const result = await generateLocalVideo(baseUrl, {
        allowPrivateNetwork: true,
        headers: { "X-DeepInfra-Trace": "transport-proof" },
      });

      expect(result.videos).toEqual([
        {
          buffer: WEBM_VIDEO,
          mimeType: "video/webm",
          fileName: "video-1.webm",
        },
      ]);
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
      const proxy = await startConnectProxy(baseUrl);
      try {
        await withEnvAsync(
          {
            HTTP_PROXY: proxy.proxyUrl,
            http_proxy: undefined,
            HTTPS_PROXY: undefined,
            https_proxy: undefined,
            NO_PROXY: undefined,
            no_proxy: undefined,
          },
          async () => {
            await generateLocalVideo(baseUrl, {
              allowPrivateNetwork: true,
              proxy: { mode: "env-proxy" },
            });
          },
        );

        expect(proxy.connectTargets).toEqual([new URL(baseUrl).host]);
        expect(requests).toHaveLength(1);
      } finally {
        await proxy.stop();
      }
    });
  });

  it.each([
    ["default", undefined],
    ["explicit false", { allowPrivateNetwork: false }],
  ])("blocks loopback before transport with %s private-network policy", async (_label, request) => {
    const requests: CapturedRequest[] = [];
    await withServer(createDeepInfraHandler(requests), async (baseUrl) => {
      await expect(generateLocalVideo(baseUrl, request)).rejects.toThrow(
        expect.objectContaining({
          name: "SsrFBlockedError",
          message: expect.stringContaining("private/internal/special-use IP address"),
        }),
      );
      expect(requests).toHaveLength(0);
    });
  });
});

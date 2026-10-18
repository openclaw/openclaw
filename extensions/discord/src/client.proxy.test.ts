import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiscordRestClient } from "./client.js";
import { RequestClient } from "./internal/rest.js";

const makeProxyFetchMock = vi.hoisted(() => vi.fn());
function restForProxy(proxy?: string) {
  return createDiscordRestClient({
    cfg: {
      channels: { discord: { token: "Bot test-token", ...(proxy === undefined ? {} : { proxy }) } },
    },
  }).rest;
}
vi.mock("openclaw/plugin-sdk/fetch-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/fetch-runtime")>(
    "openclaw/plugin-sdk/fetch-runtime",
  );
  makeProxyFetchMock.mockImplementation(actual.makeProxyFetch);
  return {
    ...actual,
    makeProxyFetch: makeProxyFetchMock,
  };
});

describe("createDiscordRestClient proxy support", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    makeProxyFetchMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    "http://mitm-proxy:8080",
    "https://user:secret@proxy.example:8443",
    "http://10.0.0.10:8080",
    "http://[::1]:8080",
  ])("uses the configured proxy fetch for %s", (proxy) => {
    const rest = restForProxy(proxy);
    expect(makeProxyFetchMock).toHaveBeenCalledWith(proxy);
    expect(rest.options.fetch).toBe(makeProxyFetchMock.mock.results[0]?.value);
  });

  it.each([undefined, "bad-proxy"])("uses direct fetch for proxy %s", (proxy) => {
    expect(restForProxy(proxy).options.fetch).toBeUndefined();
    if (proxy) {
      expect(makeProxyFetchMock).not.toHaveBeenCalledWith(proxy);
    }
  });

  it("serializes multipart media with undici-compatible FormData for proxy fetches", async () => {
    const {
      promise: receivedPromise,
      resolve: resolveReceived,
      reject: rejectReceived,
    } = createDeferred<{
      contentType: string | undefined;
      body: string;
    }>();
    const target = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("error", rejectReceived);
      req.on("end", () => {
        resolveReceived({
          contentType: req.headers["content-type"],
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Connection", "close");
        res.end(JSON.stringify({ id: "message-id", channel_id: "channel-id" }));
      });
    });
    const proxy = http.createServer();
    const tunnelSockets = new Set<Duplex>();
    target.on("error", rejectReceived);
    proxy.on("error", rejectReceived);
    // Undici's ProxyAgent tunnels HTTP targets with CONNECT. Pipe the tunnel so
    // this test exercises the production proxy fetch and its FormData rebuild.
    proxy.on("connect", (req, clientSocket, head) => {
      trackSocket(tunnelSockets, clientSocket);
      if (!req.url) {
        rejectReceived(new Error("proxy CONNECT request missing target"));
        clientSocket.destroy();
        return;
      }
      const targetUrl = new URL(`http://${req.url}`);
      const targetSocket = net.connect(Number(targetUrl.port), targetUrl.hostname, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) {
          targetSocket.write(head);
        }
        clientSocket.pipe(targetSocket);
        targetSocket.pipe(clientSocket);
      });
      trackSocket(tunnelSockets, targetSocket);
      targetSocket.on("error", rejectReceived);
      clientSocket.on("error", rejectReceived);
    });

    try {
      const targetPort = await listenOnLoopback(target, "target");
      const proxyPort = await listenOnLoopback(proxy, "proxy");
      const proxyFetch = restForProxy(`http://127.0.0.1:${proxyPort}`).options.fetch;
      assert(proxyFetch, "expected Discord proxy fetch");
      const rest = new RequestClient("test-token", {
        baseUrl: `http://127.0.0.1:${targetPort}`,
        fetch: proxyFetch,
        queueRequests: false,
      });
      const [received] = await Promise.all([
        receivedPromise,
        rest.post("/channels/123/messages", {
          body: {
            content: "with image",
            files: [{ data: Buffer.from("png-data"), name: "image.png" }],
          },
        }),
      ]);

      expect(received.contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(received.body).toContain('name="files[0]"; filename="image.png"');
      expect(received.body).toContain('name="payload_json"');
      expect(received.body).toContain('"attachments":[{"id":0,"filename":"image.png"}]');
    } finally {
      for (const socket of tunnelSockets) {
        socket.destroy();
      }
      await Promise.all([closeServer(target), closeServer(proxy)]);
    }
  });
});

function trackSocket(sockets: Set<Duplex>, socket: Duplex): void {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
}

async function listenOnLoopback(server: http.Server, label: string): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string", `failed to bind ${label} test server`);
  return address.port;
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

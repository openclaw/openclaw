import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { createDiscordRestClient } from "./client.js";
import { closeServer, listenLoopback } from "./http.test-support.js";
import { RequestClient } from "./internal/rest.js";

function restForProxy(proxy?: string) {
  return createDiscordRestClient({
    cfg: {
      channels: { discord: { token: "Bot test-token", ...(proxy === undefined ? {} : { proxy }) } },
    },
  }).rest;
}
describe("createDiscordRestClient proxy support", () => {
  it.each([
    "http://mitm-proxy:8080",
    "https://user:secret@proxy.example:8443",
    "http://10.0.0.10:8080",
    "http://[::1]:8080",
  ])("uses the configured proxy fetch for %s", (proxy) => {
    expect(restForProxy(proxy).options.fetch).toEqual(expect.any(Function));
  });

  it.each([undefined, "bad-proxy"])("uses direct fetch for proxy %s", (proxy) => {
    expect(restForProxy(proxy).options.fetch).toBeUndefined();
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
      const baseUrl = await listenLoopback(target);
      const proxyFetch = restForProxy(await listenLoopback(proxy)).options.fetch;
      assert(proxyFetch, "expected Discord proxy fetch");
      const rest = new RequestClient("test-token", {
        baseUrl,
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

import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelTrackedTextResponse } from "../../test-support/streaming-error-response.js";
import { createDiscordRestClient } from "./client.js";
import {
  getDiscordEndpointRuntime,
  resolveDiscordEndpointAttachmentGuard,
  resolveDiscordEndpointMediaGuard,
} from "./endpoint-runtime.js";
import type { Message } from "./internal/discord.js";
import { RequestClient } from "./internal/rest.js";
import { resolveMediaList } from "./monitor/message-media.js";
import { discordOutbound } from "./outbound-payload.js";
import { fetchPluralKitMessageInfo } from "./pluralkit.js";
import { sendWebhookMessageDiscord } from "./send.webhook.js";

const servers: Server[] = [];
const sockets = new Set<Duplex>();
afterEach(async () => {
  delete process.env.DISCORD_API_URL;
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();
  await Promise.all(servers.splice(0).map((server) => server[Symbol.asyncDispose]()));
});

async function startServer(
  reply: RequestListener = (_request, response) => {
    response
      .writeHead(200, { "content-type": "application/json", connection: "close" })
      .end('{"id":"message-id","channel_id":"channel-id"}');
  },
) {
  const requests: {
    url: string | undefined;
    authorization: string | undefined;
    contentType: string | undefined;
    body: string;
  }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        body,
      });
      reply(request, response);
    });
  });
  servers.push(server);
  server.on("connection", (socket) => sockets.add(socket));
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  assert(address && typeof address !== "string", "expected loopback server address");
  return { server, requests, baseUrl: `http://127.0.0.1:${address.port}` };
}

function configureEndpoint(baseUrl: string) {
  process.env.DISCORD_API_URL = `${baseUrl}/api/v10`;
  const endpoint = getDiscordEndpointRuntime();
  assert(endpoint, "expected Discord endpoint runtime");
  return endpoint;
}

describe("Discord endpoint runtime", () => {
  it("is absent by default and restores live behavior when the environment is unset", async () => {
    expect(getDiscordEndpointRuntime()).toBeUndefined();
    expect(configureEndpoint("http://127.0.0.1:43210").descriptor.restApiBaseUrl).toBe(
      "http://127.0.0.1:43210/api/v10",
    );
    delete process.env.DISCORD_API_URL;
    const fetcher = vi.fn(async () => Response.json({ id: "me" }));
    await new RequestClient("token", { fetch: fetcher, queueRequests: false }).get("/users/@me");
    expect(fetcher).toHaveBeenCalledWith(
      "https://discord.com/api/v10/users/@me",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("routes REST requests with their authentication and body to the configured origin", async () => {
    const { baseUrl, requests } = await startServer();
    configureEndpoint(baseUrl);
    await new RequestClient("proof-token", { queueRequests: false }).post("/channels/42/messages", {
      body: { content: "configured endpoint" },
    });
    expect(requests).toMatchObject([
      {
        url: "/api/v10/channels/42/messages",
        authorization: "Bot proof-token",
        body: '{"content":"configured endpoint"}',
      },
    ]);
  });

  it.each(["text", "poll", "webhook"] as const)(
    "cancels an in-flight %s send through the real transport",
    async (kind) => {
      const controller = new AbortController();
      const reason = new Error("caller stopped delivery");
      const { baseUrl, requests } = await startServer((request, response) => {
        if (request.method === "POST") {
          controller.abort(reason);
        }
        // A broken cancellation path must finish normally, not hang until a timeout.
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(
            request.method === "GET"
              ? '{"id":"42","type":0}'
              : '{"id":"message-id","channel_id":"42"}',
          );
      });
      configureEndpoint(baseUrl);
      const cfg = { channels: { discord: { token: "proof-token" } } };
      const ctx = { cfg, to: "channel:42", text: "x".repeat(4500), signal: controller.signal };
      const pending =
        kind === "webhook"
          ? sendWebhookMessageDiscord(ctx.text, {
              cfg,
              webhookId: "123",
              webhookToken: "proof-webhook-token",
              signal: controller.signal,
            })
          : kind === "poll"
            ? discordOutbound.sendPoll?.({
                ...ctx,
                poll: { question: "Pick one", options: ["A", "B"] },
              })
            : discordOutbound.sendText?.(ctx);
      assert(pending, "expected Discord sender");
      await expect(pending).rejects.toBe(reason);
      expect(
        requests.filter(({ url }) => url?.includes("/messages") || url?.includes("/webhooks/")),
      ).toHaveLength(1);
    },
  );

  it("downloads endpoint media directly instead of through an account proxy fetcher", async () => {
    const { baseUrl, requests } = await startServer();
    configureEndpoint(baseUrl);
    const proxyFetch = vi.fn(async () => new Response("proxy response", { status: 200 }));
    const message = {
      attachments: [
        {
          filename: "endpoint-media.png",
          content_type: "image/png",
          url: `${baseUrl}/media/endpoint-media.png`,
        },
      ],
    } as unknown as Message;
    const media = await resolveMediaList(message, 1024, { fetchImpl: proxyFetch });
    try {
      expect(proxyFetch).not.toHaveBeenCalled();
      expect(requests.map(({ url }) => url)).toEqual(["/media/endpoint-media.png"]);
      expect(media).toMatchObject([{ contentType: "image/png", fileName: "endpoint-media.png" }]);
    } finally {
      if (media[0]?.path) {
        await fs.unlink(media[0].path);
      }
    }
  });

  it("rejects public REST, CDN media, and upload targets before network I/O", async () => {
    const networkFetch = vi.spyOn(globalThis, "fetch");
    const endpoint = configureEndpoint("http://127.0.0.1:43210");
    await expect(
      endpoint.fetch("https://discord.com/api/v10/users/@me", {
        headers: { Authorization: "Bot must-not-leak" },
      }),
    ).rejects.toThrow(/outside the configured boundaries/);
    expect(() =>
      resolveDiscordEndpointMediaGuard("https://cdn.discordapp.com/attachments/1/asset.png"),
    ).toThrow(/outside the configured REST origin/);
    expect(() =>
      resolveDiscordEndpointAttachmentGuard("https://cdn.discordapp.com/attachments/1/upload"),
    ).toThrow(/outside the configured REST origin/);
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback plaintext API URL", () => {
    process.env.DISCORD_API_URL = "http://example.com/api/v10";
    expect(() => getDiscordEndpointRuntime()).toThrow(/HTTPS or loopback HTTP/);
  });
});

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
    const { baseUrl, requests } = await startServer();
    const proxy = await startServer();
    // Exercise the production ProxyAgent's CONNECT tunnel and FormData rebuild.
    proxy.server.on("connect", (req, clientSocket, head) => {
      assert(req.url, "proxy CONNECT request missing target");
      const targetUrl = new URL(`http://${req.url}`);
      const targetSocket = net.connect(Number(targetUrl.port), targetUrl.hostname, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) {
          targetSocket.write(head);
        }
        clientSocket.pipe(targetSocket).pipe(clientSocket);
      });
      sockets.add(targetSocket);
      targetSocket.on("error", (error) => clientSocket.destroy(error));
      clientSocket.on("error", () => targetSocket.destroy());
    });
    const proxyFetch = restForProxy(proxy.baseUrl).options.fetch;
    assert(proxyFetch, "expected Discord proxy fetch");
    const rest = new RequestClient("test-token", {
      baseUrl,
      fetch: proxyFetch,
      queueRequests: false,
    });
    await rest.post("/channels/123/messages", {
      body: {
        content: "with image",
        files: [{ data: Buffer.from("png-data"), name: "image.png" }],
      },
    });
    expect(requests[0]?.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(requests[0]?.body).toContain('name="files[0]"; filename="image.png"');
    expect(requests[0]?.body).toContain('name="payload_json"');
    expect(requests[0]?.body).toContain('"attachments":[{"id":0,"filename":"image.png"}]');
  });
});

function lookup(
  fetcher: typeof fetch,
  options: Partial<Parameters<typeof fetchPluralKitMessageInfo>[0]> = {},
) {
  return fetchPluralKitMessageInfo({
    messageId: "123",
    config: { enabled: true },
    ...options,
    fetcher,
  });
}
const rejection = (pending: Promise<unknown>) =>
  pending.then(
    () => undefined,
    (error: unknown) => {
      if (!(error instanceof Error)) {
        throw error;
      }
      return error;
    },
  );

describe("fetchPluralKitMessageInfo", () => {
  it("returns null when disabled", async () => {
    const fetcher = vi.fn();
    expect(await lookup(fetcher, { config: { enabled: false } })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("returns null on 404", async () => {
    const tracked = cancelTrackedTextResponse("missing", { status: 404 });
    expect(await lookup(async () => tracked.response)).toBeNull();
    expect(tracked.wasCanceled()).toBe(true);
  });
  it("returns payload and sends token when configured", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ member: { id: "mem_1" } }));
    const result = await lookup(fetcher, { config: { enabled: true, token: "pk_test" } });
    expect(result?.member?.id).toBe("mem_1");
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: "pk_test" });
  });
  it("aborts PluralKit response body reads that exceed the lookup timeout", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      observedSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            observedSignal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("PluralKit lookup timed out", "AbortError")),
              { once: true },
            );
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const pending = lookup(fetcher);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(observedSignal?.aborted).toBe(false);
    const failed = expect(pending).rejects.toThrow(/timed out|abort/i);
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    expect(observedSignal?.aborted).toBe(true);
  });
  it("relays parent cancellation to the PluralKit request", async () => {
    const parent = new AbortController();
    const cancellationReason = new Error("preflight stopped");
    let observedSignal: AbortSignal | undefined;
    const fetcher: typeof fetch = async (_url, init) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(cancellationReason), {
          once: true,
        });
      });
    };
    const pending = lookup(fetcher, { signal: parent.signal });
    parent.abort(cancellationReason);
    await expect(pending).rejects.toThrow("preflight stopped");
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBe(cancellationReason);
  });
  it("redacts reflected PluralKit credentials from a real HTTP error body", async () => {
    const uniqueSecret = "pluralkit-loopback-secret";
    const token = `proof-prefix-${uniqueSecret}-proof-suffix`;
    const { baseUrl, requests } = await startServer((request, response) => {
      response
        .writeHead(502, { "content-type": "text/plain" })
        .end(`proxy failure Authorization: ${request.headers.authorization}; request rejected`);
    });
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return fetch(new URL(`${url.pathname}${url.search}`, baseUrl), init);
    };
    const caught = await rejection(
      lookup(fetcher, { messageId: "boom", config: { enabled: true, token } }),
    );
    expect(requests).toMatchObject([{ url: "/v2/messages/boom", authorization: token }]);
    expect(caught?.message).toMatch(/PluralKit API failed \(502\).*proxy failure.*Authorization:/);
    expect(caught?.message).not.toContain(uniqueSecret);
  });
  it("bounds PluralKit API error bodies without using response.text()", async () => {
    const tracked = cancelTrackedTextResponse(`${"plural failure ".repeat(1024)}tail`, {
      status: 500,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    const caught = await rejection(lookup(async () => tracked.response));
    expect(caught?.message).toContain("PluralKit API failed (500): plural failure");
    expect(caught?.message).not.toContain("tail");
    expect(caught?.message.length).toBeLessThan(8_400);
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });
});

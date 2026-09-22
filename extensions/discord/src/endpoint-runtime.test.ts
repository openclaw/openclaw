import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { readRemoteMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertDiscordEndpointGatewayUrl,
  getDiscordEndpointRuntime,
  resolveDiscordEndpointAttachmentGuard,
  resolveDiscordEndpointMediaGuard,
} from "./endpoint-runtime.js";
import type { Message } from "./internal/discord.js";
import { RequestClient } from "./internal/rest.js";
import { resolveMediaList } from "./monitor/message-media.js";

let server: Server | undefined;
const DISCORD_API_URL_ENV = "DISCORD_API_URL";

afterEach(async () => {
  delete process.env[DISCORD_API_URL_ENV];
  await new Promise<void>((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  server = undefined;
  vi.restoreAllMocks();
});

async function startEndpointServer(
  onRequest: (request: import("node:http").IncomingMessage, body: string) => void,
): Promise<string> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      onRequest(request, Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => {
    server!.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected endpoint server address");
  }
  return `http://127.0.0.1:${address.port}`;
}

function configureLoopbackEndpoint(baseUrl: string) {
  process.env[DISCORD_API_URL_ENV] = `${baseUrl}/api/v10`;
  const endpoint = getDiscordEndpointRuntime();
  if (!endpoint) {
    throw new Error("expected Discord endpoint runtime");
  }
  return endpoint;
}

describe("Discord endpoint runtime", () => {
  it("is absent by default and restores live behavior when the environment is unset", async () => {
    expect(getDiscordEndpointRuntime()).toBeUndefined();
    configureLoopbackEndpoint("http://127.0.0.1:43210");
    expect(getDiscordEndpointRuntime()?.descriptor.restApiBaseUrl).toBe(
      "http://127.0.0.1:43210/api/v10",
    );
    delete process.env[DISCORD_API_URL_ENV];

    const fetcher = vi.fn(async () => new Response('{"id":"me"}', { status: 200 }));
    const client = new RequestClient("token", { fetch: fetcher, queueRequests: false });
    await client.get("/users/@me");
    expect(fetcher).toHaveBeenCalledWith(
      "https://discord.com/api/v10/users/@me",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("routes REST requests with their authentication and body to the configured origin", async () => {
    const observed: Array<{ url?: string; authorization?: string; body: string }> = [];
    const baseUrl = await startEndpointServer((request, body) => {
      observed.push({
        url: request.url,
        authorization: request.headers.authorization,
        body,
      });
    });
    configureLoopbackEndpoint(baseUrl);

    const client = new RequestClient("proof-token", { queueRequests: false });
    await client.post("/channels/42/messages", { body: { content: "configured endpoint" } });

    expect(observed).toEqual([
      {
        url: "/api/v10/channels/42/messages",
        authorization: "Bot proof-token",
        body: '{"content":"configured endpoint"}',
      },
    ]);
  });

  it("downloads endpoint media directly instead of through an account proxy fetcher", async () => {
    const observedPaths: string[] = [];
    const baseUrl = await startEndpointServer((request) => {
      observedPaths.push(request.url ?? "");
    });
    configureLoopbackEndpoint(baseUrl);
    const proxyFetch = vi.fn(async () => new Response("proxy response", { status: 200 }));
    const message = {
      attachments: [
        {
          id: "endpoint-media",
          filename: "endpoint-media.png",
          content_type: "image/png",
          url: `${baseUrl}/media/endpoint-media.png`,
        },
      ],
    } as unknown as Message;

    const media = await resolveMediaList(message, 1024, { fetchImpl: proxyFetch });
    try {
      expect(proxyFetch).not.toHaveBeenCalled();
      expect(observedPaths).toEqual(["/media/endpoint-media.png"]);
      expect(media).toEqual([
        expect.objectContaining({
          contentType: "image/png",
          fileName: "endpoint-media.png",
        }),
      ]);
    } finally {
      if (media[0]?.path) {
        await fs.unlink(media[0].path);
      }
    }
  });

  it("downloads media from the configured origin through the guarded media path", async () => {
    const observedUrls: string[] = [];
    const baseUrl = await startEndpointServer((request) => {
      observedUrls.push(request.url ?? "");
    });
    configureLoopbackEndpoint(baseUrl);
    const url = `${baseUrl}/media/asset.png`;
    const guard = resolveDiscordEndpointMediaGuard(url);

    const media = await readRemoteMediaBuffer({ url, maxBytes: 1024, ...guard });

    expect(media.buffer.toString("utf8")).toBe('{"ok":true}');
    expect(observedUrls).toEqual(["/media/asset.png"]);
  });

  it("rejects public REST, CDN media, and upload targets before network I/O", async () => {
    const networkFetch = vi.spyOn(globalThis, "fetch");
    const endpoint = configureLoopbackEndpoint("http://127.0.0.1:43210");

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

  it("accepts only the configured Gateway origin for initial and resume sockets", () => {
    configureLoopbackEndpoint("http://127.0.0.1:43210");
    const origin = "ws://127.0.0.1:43210";
    expect(() => assertDiscordEndpointGatewayUrl(`${origin}/gateway?v=10`, origin)).not.toThrow();
    expect(() =>
      assertDiscordEndpointGatewayUrl(`${origin}/gateway?resume=1`, origin),
    ).not.toThrow();
    expect(() => assertDiscordEndpointGatewayUrl("wss://gateway.discord.gg/?v=10", origin)).toThrow(
      /outside the configured WebSocket origin/,
    );
  });

  it("rejects a non-loopback plaintext API URL", () => {
    process.env[DISCORD_API_URL_ENV] = "http://example.com/api/v10";
    expect(() => getDiscordEndpointRuntime()).toThrow(/HTTPS or loopback HTTP/);
  });
});

import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
  if (server) {
    await promisify(server.close.bind(server))();
  }
  server = undefined;
  vi.restoreAllMocks();
});

async function startEndpointServer() {
  const requests: [string | undefined, string | undefined, string][] = [];
  server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push([request.url, request.headers.authorization, body]);
      response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    });
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  assert(address && typeof address !== "string", "expected endpoint server address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  configureLoopbackEndpoint(baseUrl);
  return { baseUrl, requests };
}

function configureLoopbackEndpoint(baseUrl: string) {
  process.env[DISCORD_API_URL_ENV] = `${baseUrl}/api/v10`;
  const endpoint = getDiscordEndpointRuntime();
  assert(endpoint, "expected Discord endpoint runtime");
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
    const { requests } = await startEndpointServer();

    const client = new RequestClient("proof-token", { queueRequests: false });
    await client.post("/channels/42/messages", { body: { content: "configured endpoint" } });

    expect(requests).toEqual([
      ["/api/v10/channels/42/messages", "Bot proof-token", '{"content":"configured endpoint"}'],
    ]);
  });

  it("downloads endpoint media directly instead of through an account proxy fetcher", async () => {
    const { baseUrl, requests } = await startEndpointServer();
    const proxyFetch = vi.fn(async () => new Response("proxy response", { status: 200 }));
    const attachment = {
      filename: "endpoint-media.png",
      content_type: "image/png",
      url: `${baseUrl}/media/endpoint-media.png`,
    };
    const message = { attachments: [attachment] } as unknown as Message;

    const media = await resolveMediaList(message, 1024, { fetchImpl: proxyFetch });
    try {
      expect(proxyFetch).not.toHaveBeenCalled();
      expect(requests.map(([url]) => url)).toEqual(["/media/endpoint-media.png"]);
      expect(media).toMatchObject([{ contentType: "image/png", fileName: "endpoint-media.png" }]);
    } finally {
      if (media[0]?.path) {
        await fs.unlink(media[0].path);
      }
    }
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

  it("rejects a non-loopback plaintext API URL", () => {
    process.env[DISCORD_API_URL_ENV] = "http://example.com/api/v10";
    expect(() => getDiscordEndpointRuntime()).toThrow(/HTTPS or loopback HTTP/);
  });
});

// Discord tests cover gateway metadata bounded-read real wire proof.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { fetchDiscordGatewayInfo } from "./gateway-metadata.js";

const MAX = 16 * 1024 * 1024;
const TOTAL = 18 * 1024 * 1024;

async function startLoopbackJsonServer(handler: (res: http.ServerResponse) => void): Promise<{
  port: number;
  close(): Promise<void>;
}> {
  const server = http.createServer((_req, res) => {
    handler(res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

describe("fetchDiscordGatewayInfo bounded-read real wire proof", () => {
  it("caps an oversized body streamed chunked over real wire", async () => {
    const CHUNK = 1024 * 1024;
    const srv = await startLoopbackJsonServer((res) => {
      res.writeHead(200, { "content-type": "application/json" });
      let sent = 0;
      const tick = setInterval(() => {
        if (sent < 18) {
          res.write(Buffer.alloc(CHUNK));
          sent++;
        } else {
          clearInterval(tick);
          res.end();
        }
      }, 1);
    });

    try {
      // fetchDiscordGatewayInfo hardcodes DISCORD_GATEWAY_BOT_URL but routes
      // through the injected fetchImpl; we override the URL with our loopback
      // server so the wire bytes come from the local http.createServer.
      const fetchImpl: typeof globalThis.fetch = async () => fetch(`http://127.0.0.1:${srv.port}/`);

      let captured: Error | undefined;
      try {
        await fetchDiscordGatewayInfo({
          token: "Bot test",
          fetchImpl: fetchImpl as unknown as Parameters<
            typeof fetchDiscordGatewayInfo
          >[0]["fetchImpl"],
          fetchInit: {},
        });
      } catch (err) {
        captured = err as Error;
      }
      expect(captured).toBeInstanceOf(Error);
      // The bounded-read overflow surfaces in `cause` because
      // `createGatewayMetadataError` rewraps transient errors with a generic
      // "fetch failed" message. Walk the cause chain to find the actual
      // cap-fired error. readProviderTextResponse only embeds the cap
      // (`maxBytes`) in the message, not the actual overflow size, so we
      // assert the cap value directly. The fact that the cap fired IS the
      // proof; without it, the unbounded response.text() would have happily
      // streamed all 18 MiB.
      const cause = (captured as Error & { cause?: { message?: string } }).cause;
      const haystack = `${captured?.message ?? ""}\n${cause?.message ?? ""}`;
      expect(haystack).toContain(`Discord gateway metadata: text response exceeds ${MAX} bytes`);
      console.log(
        `[discord gateway-metadata bounded-read proof] oversized path: cap=${MAX} fired server_total=${TOTAL} cause=${cause?.message ?? "none"}`,
      );
    } finally {
      await srv.close();
    }
  });

  it("returns parsed gateway info for normal-size body on real wire", async () => {
    const payload = JSON.stringify({
      url: "wss://gateway.discord.gg/",
      shards: 1,
      session_start_limit: {
        total: 1,
        remaining: 1,
        reset_after: 0,
        max_concurrency: 1,
      },
    });
    const srv = await startLoopbackJsonServer((res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
    });

    try {
      const fetchImpl: typeof globalThis.fetch = async () => fetch(`http://127.0.0.1:${srv.port}/`);

      const info = await fetchDiscordGatewayInfo({
        token: "Bot test",
        fetchImpl: fetchImpl as unknown as Parameters<
          typeof fetchDiscordGatewayInfo
        >[0]["fetchImpl"],
        fetchInit: {},
      });
      expect(info.url).toBe("wss://gateway.discord.gg/");
      expect(info.shards).toBe(1);
      expect(info.session_start_limit.total).toBe(1);
      console.log(
        `[discord gateway-metadata bounded-read proof] normal path: url=${info.url} shards=${info.shards}`,
      );
    } finally {
      await srv.close();
    }
  });
});

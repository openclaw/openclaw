// Discord tests cover gateway metadata plugin behavior.
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchDiscordGatewayInfo,
  fetchDiscordGatewayMetadataGuarded,
  resolveDiscordGatewayInfoTimeoutMs,
  resolveGatewayInfoWithFallback,
} from "./gateway-metadata.js";

const DISCORD_GATEWAY_METADATA_MAX_BYTES = 4 * 1024 * 1024;

const { mockFetchWithSsrFGuard } = vi.hoisted(() => ({
  mockFetchWithSsrFGuard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mockFetchWithSsrFGuard,
}));

async function listenLoopbackServer(server: Server): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected loopback TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function stubGuardedFetch(response: Response): void {
  mockFetchWithSsrFGuard.mockResolvedValue({
    response,
    release: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  });
}

describe("Discord gateway metadata", () => {
  it("resolves gateway info timeouts from strict integer config and env values", () => {
    expect(resolveDiscordGatewayInfoTimeoutMs({ configuredTimeoutMs: 45_000 })).toBe(45_000);
    expect(
      resolveDiscordGatewayInfoTimeoutMs({
        env: { OPENCLAW_DISCORD_GATEWAY_INFO_TIMEOUT_MS: "90000" },
      }),
    ).toBe(90_000);
    expect(resolveDiscordGatewayInfoTimeoutMs({ configuredTimeoutMs: 150_000 })).toBe(120_000);
    expect(
      resolveDiscordGatewayInfoTimeoutMs({
        configuredTimeoutMs: 1.5,
        env: { OPENCLAW_DISCORD_GATEWAY_INFO_TIMEOUT_MS: "0x1000" },
      }),
    ).toBe(30_000);
    expect(
      resolveDiscordGatewayInfoTimeoutMs({
        env: { OPENCLAW_DISCORD_GATEWAY_INFO_TIMEOUT_MS: "1e3" },
      }),
    ).toBe(30_000);
  });

  it("falls back on Cloudflare HTML rate limits without logging raw HTML", async () => {
    const error = await fetchDiscordGatewayInfo({
      token: "test",
      fetchImpl: async () =>
        new Response("<html><title>Error 1015</title><body>rate limited</body></html>", {
          status: 429,
          headers: { "content-type": "text/html" },
        }),
    }).catch((err: unknown) => err);
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const resolved = resolveGatewayInfoWithFallback({ runtime, error });

    expect(resolved.usedFallback).toBe(true);
    expect(resolved.info.url).toBe("wss://gateway.discord.gg/");
    const logs = runtime.log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logs).toBe(
      "discord: gateway metadata lookup failed transiently; using default gateway url (Failed to get gateway information from Discord: fetch failed | Discord API /gateway/bot failed (429): Error 1015 rate limited)",
    );
  });
});

describe("fetchDiscordGatewayMetadataGuarded bounded reads", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockFetchWithSsrFGuard.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns under-cap response body from a real loopback HTTP server", async () => {
    const payload = JSON.stringify({
      url: "wss://gateway.discord.gg/",
      shards: 1,
      session_start_limit: {
        total: 1000,
        remaining: 999,
        reset_after: 3600000,
        max_concurrency: 1,
      },
    });

    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write(payload.slice(0, 32));
      res.end(payload.slice(32));
    });
    const port = await listenLoopbackServer(server);

    try {
      const rawResponse = await fetch(`http://127.0.0.1:${port}`);
      stubGuardedFetch(rawResponse);

      const response = await fetchDiscordGatewayMetadataGuarded(
        "https://discord.com/api/v10/gateway/bot",
      );
      const text = await response.text();
      expect(JSON.parse(text)).toEqual(JSON.parse(payload));
      console.log(
        `[discord gateway metadata loopback proof] normal path: returned valid gateway metadata`,
      );
    } finally {
      await closeServer(server);
    }
  });

  it("rejects oversized response body from a real loopback HTTP server", async () => {
    const oversizedPayloadBytes = DISCORD_GATEWAY_METADATA_MAX_BYTES + 256 * 1024;
    let streamedBytes = 0;

    const server = createServer((req, res) => {
      const chunk = Buffer.alloc(64 * 1024, 0x78);
      res.writeHead(200, { "content-type": "application/json" });

      const writeMore = () => {
        while (streamedBytes < oversizedPayloadBytes) {
          if (res.destroyed) {
            return;
          }
          streamedBytes += chunk.byteLength;
          if (!res.write(chunk)) {
            res.once("drain", writeMore);
            return;
          }
        }
        res.end();
      };

      writeMore();
    });
    const port = await listenLoopbackServer(server);

    try {
      const rawResponse = await fetch(`http://127.0.0.1:${port}`);
      stubGuardedFetch(rawResponse);

      let error: unknown;
      try {
        await fetchDiscordGatewayMetadataGuarded("https://discord.com/api/v10/gateway/bot");
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("Discord gateway metadata response body too large");
      expect(String(error)).toContain(`limit: ${DISCORD_GATEWAY_METADATA_MAX_BYTES} bytes`);
      console.log(
        `[discord gateway metadata loopback proof] oversized path: cap=${DISCORD_GATEWAY_METADATA_MAX_BYTES} streamed>=${streamedBytes} rejected=${String(error)}`,
      );
    } finally {
      await closeServer(server);
    }
  });
});

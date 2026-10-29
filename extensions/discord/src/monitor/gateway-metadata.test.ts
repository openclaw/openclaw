import { createServer } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback as listenLoopbackServer } from "../../../test-support/hanging-loopback-server.js";
import { createRuntimeSpies } from "../../../test-support/runtime-spies.js";
import {
  fetchDiscordGatewayInfoWithTimeout,
  fetchDiscordGatewayMetadataGuarded,
  resolveDiscordGatewayInfoTimeoutMs,
  resolveGatewayInfoWithFallback,
} from "./gateway-metadata.js";

const DISCORD_GATEWAY_METADATA_MAX_BYTES = 4 * 1024 * 1024;
const gatewayUrl = "https://discord.com/api/v10/gateway/bot";
const payload = { url: "wss://gateway.discord.gg/" };

const { mockFetchWithSsrFGuard } = vi.hoisted(() => ({
  mockFetchWithSsrFGuard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mockFetchWithSsrFGuard,
}));

const captureHost = vi.hoisted(() => ({
  capture: vi.fn<typeof import("openclaw/plugin-sdk/proxy-capture").captureHttpExchangeAsync>(),
}));

vi.mock("openclaw/plugin-sdk/proxy-capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/proxy-capture")>()),
  captureHttpExchangeAsync: captureHost.capture,
}));

function stubGuardedFetch(response: Response) {
  const release = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  mockFetchWithSsrFGuard.mockResolvedValue({
    response,
    release,
  });
  return release;
}

describe("Discord gateway metadata", () => {
  it("resolves gateway info timeouts from strict integer env values", () => {
    expect(
      ["90000", "0x1000", "1e3"].map((value) =>
        resolveDiscordGatewayInfoTimeoutMs({
          env: { OPENCLAW_DISCORD_GATEWAY_INFO_TIMEOUT_MS: value },
        }),
      ),
    ).toEqual([90_000, 30_000, 30_000]);
  });

  it("falls back on Cloudflare HTML rate limits without logging raw HTML", async () => {
    const error = await fetchDiscordGatewayInfoWithTimeout({
      token: "test",
      fetchImpl: async () =>
        new Response("<html><title>Error 1015</title><body>rate limited</body></html>", {
          status: 429,
          headers: { "content-type": "text/html" },
        }),
      timeoutMs: 1_000,
    }).catch((err: unknown) => err);
    const runtime = createRuntimeSpies();

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
    captureHost.capture.mockReset().mockResolvedValue(undefined);
  });

  it.each(["absent", "present", "rejected"] as const)(
    "returns gateway metadata and releases transport with %s async capture",
    async (capability) => {
      if (capability === "rejected") {
        captureHost.capture.mockRejectedValue(new Error("capture write failed"));
      }
      const release = stubGuardedFetch(
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        }),
      );
      const response = await fetchDiscordGatewayMetadataGuarded(gatewayUrl, undefined, {
        capture:
          capability === "absent"
            ? undefined
            : {
                flowId: "metadata-flow",
                meta: { subsystem: "discord-gateway-metadata" },
              },
      });

      await expect(response.json()).resolves.toEqual(payload);
      expect(release).toHaveBeenCalledOnce();
      if (capability === "absent") {
        expect(captureHost.capture).not.toHaveBeenCalled();
        return;
      }
      expect(captureHost.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          response,
          flowId: "metadata-flow",
          meta: { subsystem: "discord-gateway-metadata" },
        }),
      );
    },
  );

  it("aborts stalled DNS preflight through the gateway metadata deadline", async () => {
    const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
      "openclaw/plugin-sdk/ssrf-runtime",
    );
    const lookup = createDeferred<Array<{ address: string; family: 4 }>>();
    const lookupFn = vi.fn(async () => await lookup.promise);
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    let guardSettled = false;
    mockFetchWithSsrFGuard.mockImplementation(async (params) => {
      try {
        return await actual.fetchWithSsrFGuard({
          ...params,
          fetchImpl,
          lookupFn,
        });
      } finally {
        guardSettled = true;
      }
    });

    const fetchPromise = fetchDiscordGatewayInfoWithTimeout({
      token: "test",
      timeoutMs: 250,
      fetchImpl: fetchDiscordGatewayMetadataGuarded,
    }).catch((error: unknown) => error);

    try {
      await vi.waitFor(() => expect(lookupFn).toHaveBeenCalledOnce());
      const guardedParams = mockFetchWithSsrFGuard.mock.calls[0]?.[0];
      expect(guardedParams.signal).toBe(guardedParams.init.signal);
      expect(guardedParams).not.toHaveProperty("timeoutMs");

      await expect(fetchPromise).resolves.toBeInstanceOf(Error);
      await vi.waitFor(() => expect(guardSettled).toBe(true));
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      lookup.resolve([{ address: "162.159.136.234", family: 4 }]);
    }
    await Promise.resolve();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects oversized response body from a real loopback HTTP server", async () => {
    const server = createServer((_request, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(Buffer.alloc(DISCORD_GATEWAY_METADATA_MAX_BYTES + 256 * 1024, 0x78));
    });
    const port = await listenLoopbackServer(server);

    try {
      const rawResponse = await fetch(`http://127.0.0.1:${port}`);
      const release = stubGuardedFetch(rawResponse);

      await expect(fetchDiscordGatewayMetadataGuarded(gatewayUrl)).rejects.toThrow(
        new RegExp(
          `Discord gateway metadata response body too large: \\d+ bytes \\(limit: ${DISCORD_GATEWAY_METADATA_MAX_BYTES} bytes\\)`,
        ),
      );
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await server[Symbol.asyncDispose]();
    }
  });
});

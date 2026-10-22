import { createServer, type RequestListener, type Server } from "node:http";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { withFetchPreconnect, type FetchMock } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelTrackedTextResponse } from "../../test-support/streaming-error-response.js";
import { DiscordApiError, fetchDiscord, requestDiscord } from "./api.js";
import { jsonResponse } from "./test-http-helpers.js";

const DISCORD_SUCCESS_RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;
const servers: Server[] = [];

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

async function mockDiscordServer(
  handler: RequestListener,
  onResponse?: (response: Response) => void,
): Promise<void> {
  const server = createServer(handler);
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${await listenLoopbackServer(server)}`;
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal(
    "fetch",
    withFetchPreconnect(async (input: RequestInfo | URL, init?: RequestInit) => {
      const originalUrl = new URL(input instanceof Request ? input.url : String(input));
      expect(originalUrl.origin).toBe("https://discord.com");
      expect(originalUrl.pathname).toMatch(/^\/api\/v10\//);
      const loopbackUrl = new URL(`${originalUrl.pathname}${originalUrl.search}`, baseUrl);
      const response = await realFetch(loopbackUrl, init);
      onResponse?.(response);
      return response;
    }),
  );
}

async function fetchError(response: Response) {
  const fetcher = withFetchPreconnect(async () => response);
  return await fetchDiscord("/users/@me/guilds", "test", fetcher, {
    retry: { attempts: 1 },
  }).catch((err: unknown) => err);
}

function successfulFetch() {
  return withFetchPreconnect(vi.fn<FetchMock>(async () => jsonResponse({ id: "42" }, 200)));
}

describe("fetchDiscord", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("bounds Discord API error bodies without using response.text()", async () => {
    const tracked = cancelTrackedTextResponse(`${"discord api unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    const error = await fetchError(tracked.response);

    expect(error).toBeInstanceOf(DiscordApiError);
    expect(String(error)).toContain("Discord API /users/@me/guilds failed (503)");
    expect(String(error)).toContain("discord api unavailable");
    expect(String(error)).not.toContain("tail");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("sanitizes Cloudflare HTML rate limits and applies a fallback cooldown", async () => {
    const error = await fetchError(
      new Response(
        "<!doctype html><html><head><title>Error 1015</title></head><body><h1>You are being rate limited</h1><script>raw()</script></body></html>",
        { status: 429, headers: { "content-type": "text/html" } },
      ),
    );

    expect(error).toBeInstanceOf(DiscordApiError);
    expect((error as DiscordApiError).retryAfter).toBe(60);
    const message = String(error);
    expect(message).toContain("Discord API /users/@me/guilds failed (429)");
    expect(message).toContain("rate limited by Discord upstream");
    expect(message).toContain("Error 1015");
    expect(message).not.toContain("<html");
    expect(message).not.toContain("<script");
  });

  it("ignores unsafe retry_after body values and falls back to Retry-After", async () => {
    const error = await fetchError(
      new Response(
        JSON.stringify({ message: "You are being rate limited.", retry_after: 9_007_199_254_741 }),
        { status: 429, headers: { "retry-after": "7" } },
      ),
    );

    expect(error).toBeInstanceOf(DiscordApiError);
    expect((error as DiscordApiError).retryAfter).toBe(7);
    expect(String(error)).not.toContain("retry after");
  });

  it("retries rate limits before succeeding", async () => {
    let calls = 0;
    const fetcher = withFetchPreconnect(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({ message: "You are being rate limited.", retry_after: 0 }, 429);
      }
      return jsonResponse([{}], 200);
    });

    const result = await fetchDiscord<unknown[]>("/users/@me/guilds", "test", fetcher, {
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    expect(result).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("sends JSON request bodies through the shared retry helper", async () => {
    const fetcher = successfulFetch();

    const result = await requestDiscord<{ id: string }>("/channels/c/messages", "test", {
      body: { content: "hello" },
      fetcher,
      retry: { attempts: 1 },
    });

    const request = fetcher.mock.calls[0]?.[1];
    expect(result).toEqual({ id: "42" });
    expect(request).toMatchObject({ method: "POST", body: JSON.stringify({ content: "hello" }) });
    expect(new Headers(request?.headers).get("content-type")).toBe("application/json");
  });

  it("caps oversized request timeouts before creating abort signals", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const fetcher = successfulFetch();

    await requestDiscord<{ id: string }>("/channels/c/messages", "test", {
      fetcher,
      retry: { attempts: 1 },
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(setTimeoutSpy.mock.results[0]?.value);
  });

  it("rejects malformed UTF-8 in otherwise valid Discord JSON", async () => {
    let response: Response | undefined;
    await mockDiscordServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('[{"id":"guild-');
        res.write(Buffer.from([0xff]));
        res.end('"}]');
      },
      (nextResponse) => {
        response = nextResponse;
      },
    );
    await expect(
      requestDiscord("/users/@me/guilds", "test", { retry: { attempts: 1 } }),
    ).rejects.toThrow("Discord API /users/@me/guilds returned malformed JSON");
    expect(response?.bodyUsed).toBe(true);
  });

  it.each(["HTML", "JSON"])("redacts reflected bot credentials from %s errors", async (format) => {
    const json = format === "JSON";
    const status = json ? 429 : 502;
    const uniqueSecret = "discord-loopback-secret";
    const token = `proof-prefix-${uniqueSecret}-proof-suffix`;
    let authorization: string | undefined;
    await mockDiscordServer((req, res) => {
      authorization = req.headers.authorization;
      const message = `proxy failure Authorization: ${authorization}; request rejected`;
      res.writeHead(status, { "content-type": json ? "application/json" : "text/html" });
      res.end(
        json ? JSON.stringify({ message, retry_after: 0 }) : `<html><body>${message}</body></html>`,
      );
    });
    const error = await requestDiscord("/gateway/bot", token, {
      retry: { attempts: 1 },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(DiscordApiError);
    expect(authorization).toBe(`Bot ${token}`);
    const message = String(error);
    expect(message).toContain(`Discord API /gateway/bot failed (${status})`);
    expect(message).toContain("proxy failure");
    expect(message).toContain("Authorization: Bot");
    expect(message).not.toContain(token);
    expect(message).not.toContain(uniqueSecret);
    if (json) {
      expect(error).toMatchObject({ retryAfter: 0 });
      expect(message).toContain("retry after 0.0s");
    } else {
      expect(message).not.toContain("<html");
    }
  });

  it("rejects oversized valid JSON requestDiscord responses from a real loopback HTTP server", async () => {
    const oversizedPayloadBytes = DISCORD_SUCCESS_RESPONSE_LIMIT_BYTES + 256 * 1024;
    let contentLength: string | null | undefined;
    let requestUrl: string | undefined;
    await mockDiscordServer(
      (req, res) => {
        requestUrl = req.url;
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"id":"');
        res.end(`${"x".repeat(oversizedPayloadBytes)}"}`);
      },
      (response) => {
        contentLength = response.headers.get("content-length");
      },
    );
    const error = await requestDiscord("/channels/123/messages", "test-token", {
      retry: { attempts: 1 },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("Discord API /channels/123/messages response body too large");
    expect(String(error)).toContain(`limit: ${DISCORD_SUCCESS_RESPONSE_LIMIT_BYTES} bytes`);
    expect(requestUrl).toBe("/api/v10/channels/123/messages");
    expect(contentLength).toBeNull();
  });

  it("aborts promptly during 429 retry backoff when the caller signal fires", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () =>
      jsonResponse({ message: "rate limited", retry_after: 30 }, 429),
    );
    const controller = new AbortController();
    const request = requestDiscord("/users/@me/guilds", "test-token", {
      fetcher: withFetchPreconnect(fetcher),
      retry: { attempts: 3 },
      signal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    controller.abort();

    await expect(request).rejects.toThrow(/abort/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

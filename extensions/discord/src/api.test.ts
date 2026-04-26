import { withFetchPreconnect } from "openclaw/plugin-sdk/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordApiError, fetchDiscord } from "./api.js";
import { jsonResponse } from "./test-http-helpers.js";

describe("fetchDiscord", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("formats rate limit payloads without raw JSON", async () => {
    const fetcher = withFetchPreconnect(async () =>
      jsonResponse(
        {
          message: "You are being rate limited.",
          retry_after: 0.631,
          global: false,
        },
        429,
      ),
    );

    let error: unknown;
    try {
      await fetchDiscord("/users/@me/guilds", "test", fetcher, {
        retry: { attempts: 1 },
      });
    } catch (err) {
      error = err;
    }

    const message = String(error);
    expect(message).toContain("Discord API /users/@me/guilds failed (429)");
    expect(message).toContain("You are being rate limited.");
    expect(message).toContain("retry after 0.6s");
    expect(message).not.toContain("{");
    expect(message).not.toContain("retry_after");
  });

  it("preserves non-JSON error text", async () => {
    const fetcher = withFetchPreconnect(async () => new Response("Not Found", { status: 404 }));
    await expect(
      fetchDiscord("/users/@me/guilds", "test", fetcher, {
        retry: { attempts: 1 },
      }),
    ).rejects.toThrow("Discord API /users/@me/guilds failed (404): Not Found");
  });

  it("sanitizes Cloudflare HTML rate limits and honors Retry-After", async () => {
    const html = `<!doctype html>
      <html>
        <head><title>Error 1015</title><style>.hidden{display:none}</style></head>
        <body><h1>You are being rate limited</h1><script>alert("token")</script></body>
      </html>`;
    const fetcher = withFetchPreconnect(
      async () =>
        new Response(html, {
          status: 429,
          headers: { "Retry-After": "7" },
        }),
    );

    let error: unknown;
    try {
      await fetchDiscord("/users/@me/guilds", "test", fetcher, {
        retry: { attempts: 1 },
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(DiscordApiError);
    expect((error as DiscordApiError).retryAfter).toBe(7);
    const message = String(error);
    expect(message).toContain("Discord API /users/@me/guilds failed (429)");
    expect(message).toContain("HTML response:");
    expect(message).toContain("Error 1015");
    expect(message).toContain("You are being rate limited");
    expect(message).not.toContain("<html");
    expect(message).not.toContain("<script");
    expect(message).not.toContain("alert");
  });

  it("waits the full Retry-After before retrying HTML rate limits", async () => {
    vi.useFakeTimers();
    const html = "<html><title>Error 1015</title><body>rate limited</body></html>";
    let calls = 0;
    const fetcher = withFetchPreconnect(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(html, {
          status: 429,
          headers: { "Retry-After": "7" },
        });
      }
      return jsonResponse([{ id: "1", name: "Guild" }], 200);
    });

    const resultPromise = fetchDiscord<Array<{ id: string; name: string }>>(
      "/users/@me/guilds",
      "test",
      fetcher,
      { retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 30_000 } },
    );

    await vi.waitFor(() => expect(calls).toBe(1));
    await vi.advanceTimersByTimeAsync(6_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);

    await expect(resultPromise).resolves.toEqual([{ id: "1", name: "Guild" }]);
  });

  it("uses a conservative cooldown for application metadata HTML rate limits", async () => {
    const fetcher = withFetchPreconnect(
      async () =>
        new Response("<html><title>Error 1015</title><body>rate limited</body></html>", {
          status: 429,
        }),
    );

    let error: unknown;
    try {
      await fetchDiscord("/oauth2/applications/@me", "test", fetcher, {
        retry: { attempts: 1 },
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(DiscordApiError);
    expect((error as DiscordApiError).retryAfter).toBe(30);
    expect(String(error)).toContain("Discord API /oauth2/applications/@me failed (429)");
    expect(String(error)).not.toContain("<body>");
  });

  it("retries rate limits before succeeding", async () => {
    let calls = 0;
    const fetcher = withFetchPreconnect(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(
          {
            message: "You are being rate limited.",
            retry_after: 0,
            global: false,
          },
          429,
        );
      }
      return jsonResponse([{ id: "1", name: "Guild" }], 200);
    });

    const result = await fetchDiscord<Array<{ id: string; name: string }>>(
      "/users/@me/guilds",
      "test",
      fetcher,
      { retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 } },
    );

    expect(result).toHaveLength(1);
    expect(calls).toBe(2);
  });
});

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { cancelTrackedTextResponse } from "../../test-support/streaming-error-response.js";
import { DiscordError } from "./internal/rest-errors.js";
import { DISCORD_REST_TIMEOUT_MS } from "./proxy-request-client.js";
import { sendWebhookMessageDiscord } from "./send.webhook.js";

const { makeProxyFetchMock, recordChannelActivityMock } = vi.hoisted(() => ({
  makeProxyFetchMock: vi.fn(),
  recordChannelActivityMock: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>()),
  makeProxyFetch: makeProxyFetchMock,
}));
vi.mock("openclaw/plugin-sdk/channel-activity-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-activity-runtime")>()),
  recordChannelActivity: recordChannelActivityMock,
}));

const cfg: OpenClawConfig = { channels: { discord: { token: "Bot test-token" } } };
const opts = { cfg, webhookId: "123", webhookToken: "abc" };
let fetchMock: MockInstance<typeof fetch>;

describe("Discord webhook transport", () => {
  beforeEach(() => {
    makeProxyFetchMock.mockReset();
    recordChannelActivityMock.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ id: "msg-1", channel_id: "thread-1" }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    {
      name: "account opt-out",
      config: { suppressEmbeds: true, accounts: { runtime: { suppressEmbeds: false } } },
      flags: undefined,
    },
  ])("applies $name link-preview suppression", async ({ config, flags }) => {
    await sendWebhookMessageDiscord("https://example.com", {
      ...opts,
      cfg: { channels: { discord: config } },
      accountId: "runtime",
    });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ content: "https://example.com", flags }),
    );
  });

  it("uses the configured proxy fetch", async () => {
    const proxiedFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "proxied" }));
    makeProxyFetchMock.mockReturnValue(proxiedFetch);
    await sendWebhookMessageDiscord("hello", {
      ...opts,
      cfg: { channels: { discord: { proxy: "http://proxy.test:8080" } } },
    });
    expect(makeProxyFetchMock).toHaveBeenCalledWith("http://proxy.test:8080");
    expect(proxiedFetch).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the no-body response when wait is false", async () => {
    const response = new Response(null, { status: 204 });
    const jsonSpy = vi.spyOn(response, "json");
    fetchMock.mockResolvedValue(response);
    expect((await sendWebhookMessageDiscord("hello", { ...opts, wait: false })).messageId).toBe("");
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it("keeps an accepted send when the response body exceeds the limit", async () => {
    const tracked = cancelTrackedTextResponse(`{"id":"${"x".repeat(16 * 1024 * 1024)}"}`, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    fetchMock.mockResolvedValue(tracked.response);
    expect((await sendWebhookMessageDiscord("hello", opts)).messageId).toBe("");
    expect(tracked.wasCanceled()).toBe(true);
  });

  it.each(["rate limit", "pre-connect failure"] as const)(
    "retries a proven %s within its budget and cleans up the deadline",
    async (failure) => {
      if (failure === "rate limit") {
        fetchMock.mockImplementation(async () =>
          Response.json(
            { message: "Slow down", retry_after: 0.75, global: false },
            { status: 429 },
          ),
        );
      } else {
        fetchMock.mockRejectedValueOnce(
          Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
        );
      }
      const sent = sendWebhookMessageDiscord("hello", { ...opts, threadId: "thread-1" });
      const result =
        failure === "rate limit"
          ? expect(sent).rejects.toMatchObject({
              name: "RateLimitError",
              status: 429,
              retryAfter: 0.75,
            })
          : expect(sent).resolves.toMatchObject({ messageId: "msg-1", channelId: "thread-1" });
      if (failure === "rate limit") {
        await vi.advanceTimersByTimeAsync(749);
        expect(fetchMock).toHaveBeenCalledOnce();
      }
      await vi.advanceTimersByTimeAsync(1_000);
      await result;
      expect(fetchMock).toHaveBeenCalledTimes(failure === "rate limit" ? 3 : 2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bounds an ambiguous error body without replaying the send", async () => {
    const tracked = cancelTrackedTextResponse(`${"upstream unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    fetchMock.mockResolvedValue(tracked.response);
    const error: unknown = await sendWebhookMessageDiscord("hello", opts).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(DiscordError);
    if (!(error instanceof DiscordError)) {
      throw error;
    }
    expect(error.status).toBe(503);
    expect(error.message).toContain("upstream unavailable");
    expect(JSON.stringify(error.rawBody)).not.toContain("tail");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("aborts when Discord never returns response headers", async () => {
    fetchMock.mockImplementation((_input, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("expected webhook request signal");
      }
      return new Promise<Response>((_resolve, reject) => {
        const abort = () =>
          reject(signal.reason instanceof Error ? signal.reason : new Error("request aborted"));
        if (signal.aborted) {
          abort();
        } else {
          signal.addEventListener("abort", abort, { once: true });
        }
      });
    });
    const rejection = expect(sendWebhookMessageDiscord("hello", opts)).rejects.toMatchObject({
      name: "TimeoutError",
      message: "request timed out",
    });
    await Promise.all([vi.advanceTimersByTimeAsync(DISCORD_REST_TIMEOUT_MS), rejection]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([200, 503])("keeps the deadline active through a stalled %s body", async (status) => {
    fetchMock.mockImplementation(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("expected webhook request signal");
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          },
        }),
        { status },
      );
    });
    const rejection = expect(sendWebhookMessageDiscord("hello", opts)).rejects.toMatchObject({
      name: "TimeoutError",
      message: "request timed out",
    });
    await Promise.all([vi.advanceTimersByTimeAsync(DISCORD_REST_TIMEOUT_MS), rejection]);
  });

  it("aborts rate-limit backoff at the deadline without leaving a retry timer", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ message: "Slow down", retry_after: 60 }, { status: 429 }),
    );
    const rejection = expect(sendWebhookMessageDiscord("hello", opts)).rejects.toMatchObject({
      name: "TimeoutError",
      message: "request timed out",
    });
    await Promise.all([vi.advanceTimersByTimeAsync(DISCORD_REST_TIMEOUT_MS), rejection]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

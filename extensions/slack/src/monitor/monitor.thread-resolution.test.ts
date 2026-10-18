import {
  WebClient,
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
} from "@slack/web-api";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlackIngressTurnLifecycle } from "./ingress.types.js";
import {
  createSlackThreadTsResolver,
  isTransientSlackThreadLookupError,
} from "./thread-resolution.js";

const ambiguous = { _ambiguousThreadReply: true };
const resolved = { thread_ts: "9" };

type SlackThreadClient = Parameters<typeof createSlackThreadTsResolver>[0]["client"];

function createResolver(history: ReturnType<typeof vi.fn>) {
  const resolver = createSlackThreadTsResolver({
    client: { conversations: { history } } as unknown as SlackThreadClient,
  });
  const message = { type: "message" as const, channel: "C1", parent_user_id: "U2", ts: "1" };
  return (
    source: "message" | "app_mention" = "message",
    turnAdoptionLifecycle?: SlackIngressTurnLifecycle,
  ) => resolver.resolve({ message, source, turnAdoptionLifecycle });
}

function createWebClient(fetch: NonNullable<ConstructorParameters<typeof WebClient>[1]>["fetch"]) {
  return new WebClient("xoxb-test", {
    fetch,
    retryConfig: { retries: 0 },
    slackApiUrl: "https://slack.test/api/",
  });
}

function createDurableTurnLifecycle(): SlackIngressTurnLifecycle {
  return {
    admission: "exclusive",
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(),
    onDeferred: vi.fn(),
    onAbandoned: vi.fn(),
  };
}

describe("createSlackThreadTsResolver", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("caches resolved thread_ts lookups", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const historyMock = vi.fn().mockResolvedValue({
      messages: [{ ts: "1", thread_ts: "9" }],
    });
    const resolve = createResolver(historyMock);

    expect((await resolve("message")).thread_ts).toBe("9");
    expect((await resolve("message")).thread_ts).toBe("9");
    expect(historyMock).toHaveBeenCalledTimes(1);
    nowSpy.mockReturnValue(1_700_000_060_000);
    expect((await resolve("message")).thread_ts).toBe("9");
    expect(historyMock).toHaveBeenCalledTimes(2);
  });

  it("classifies an exhausted real WebClient 429 as transient", async () => {
    const fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        headers: { "content-type": "application/json", "retry-after": "0" },
        status: 429,
      });
    });
    const client = createWebClient(fetch);

    const error: unknown = await client.users
      .info({ user: "U1" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WebAPIRequestError);
    if (!(error instanceof WebAPIRequestError)) {
      throw new Error("expected exhausted Slack 429 to become WebAPIRequestError");
    }
    expect(error.original.message).toMatch(
      /^A rate limit was exceeded \(url: .+, retry-after: 0\)$/,
    );
    expect(isTransientSlackThreadLookupError(error)).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("classifies a real WebClient internal_error platform response as transient", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: false, error: "internal_error" }));
    const error: unknown = await createWebClient(fetch)
      .users.info({ user: "U1" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WebAPIPlatformError);
    expect(isTransientSlackThreadLookupError(error)).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("hands a Slack rate-limit error to durable ingress without poisoning the cache", async () => {
    const error = new WebAPIRateLimitedError(1);
    const historyMock = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ messages: [{ ts: "1", thread_ts: "9" }] });
    const resolve = createResolver(historyMock);
    const turnAdoptionLifecycle = createDurableTurnLifecycle();

    await expect(resolve("message", turnAdoptionLifecycle)).rejects.toBe(error);
    await expect(resolve("app_mention", turnAdoptionLifecycle)).resolves.toMatchObject(resolved);

    expect(historyMock).toHaveBeenCalledTimes(2);
  });

  it("keeps direct transient failures ambiguous without poisoning their future lookup", async () => {
    const historyMock = vi
      .fn()
      .mockRejectedValueOnce(new WebAPIHTTPError(503, "Service Unavailable", {}, "outage"))
      .mockResolvedValueOnce({ messages: [{ ts: "1", thread_ts: "9" }] });
    const resolve = createResolver(historyMock);

    await expect(resolve("message")).resolves.toMatchObject(ambiguous);
    await expect(resolve("app_mention")).resolves.toMatchObject(resolved);

    expect(historyMock).toHaveBeenCalledTimes(2);
  });

  it("releases all coalesced durable twins for their existing queue retry", async () => {
    const history = createDeferred<{ messages: Array<{ ts: string; thread_ts: string }> }>();
    const historyMock = vi
      .fn()
      .mockReturnValueOnce(history.promise)
      .mockResolvedValueOnce({ messages: [{ ts: "1", thread_ts: "9" }] });
    const resolve = createResolver(historyMock);
    const firstLifecycle = createDurableTurnLifecycle();
    const secondLifecycle = createDurableTurnLifecycle();
    const first = resolve("message", firstLifecycle);
    const second = resolve("app_mention", secondLifecycle);
    const outage = new WebAPIHTTPError(503, "Service Unavailable", {}, "outage");

    expect(historyMock).toHaveBeenCalledTimes(1);
    history.reject(outage);
    await expect(Promise.allSettled([first, second])).resolves.toEqual([
      { status: "rejected", reason: outage },
      { status: "rejected", reason: outage },
    ]);
    await expect(resolve("message", firstLifecycle)).resolves.toMatchObject(resolved);
    expect(historyMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "Slack platform missing_scope",
      new WebAPIPlatformError({ ok: false, error: "missing_scope" }),
    ],
    ["unclassified local failure", new Error("local lookup unavailable")],
    [
      "uncoded Slack request failure",
      new WebAPIRequestError(new Error("request failed without a transient signal")),
    ],
  ])("preserves cached ambiguity for definitive %s", async (_label, error) => {
    const historyMock = vi.fn().mockRejectedValue(error);
    const resolve = createResolver(historyMock);
    const turnAdoptionLifecycle = createDurableTurnLifecycle();

    await expect(resolve("message", turnAdoptionLifecycle)).resolves.toMatchObject(ambiguous);
    await expect(resolve("app_mention", turnAdoptionLifecycle)).resolves.toMatchObject(ambiguous);
    expect(historyMock).toHaveBeenCalledTimes(1);
  });
});

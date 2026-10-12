// Slack tests cover monitor.thread resolution plugin behavior.
import {
  WebClient,
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
} from "@slack/web-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../types.js";
import type { SlackIngressTurnLifecycle } from "./ingress.types.js";
import {
  createSlackThreadTsResolver,
  isTransientSlackThreadLookupError,
} from "./thread-resolution.js";

type SlackThreadClient = Parameters<typeof createSlackThreadTsResolver>[0]["client"];

function createThreadClient(history: ReturnType<typeof vi.fn>): SlackThreadClient {
  return { conversations: { history } } as unknown as SlackThreadClient;
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

  function makeThreadReplyMessage(ts: string): SlackMessageEvent {
    return {
      channel: "C1",
      parent_user_id: "U2",
      ts,
    } as SlackMessageEvent;
  }

  it("caches resolved thread_ts lookups", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const historyMock = vi.fn().mockResolvedValue({
      messages: [{ ts: "1", thread_ts: "9" }],
    });
    const resolver = createSlackThreadTsResolver({
      client: createThreadClient(historyMock),
    });

    const message = makeThreadReplyMessage("1");

    const first = await resolver.resolve({ message, source: "message" });
    const second = await resolver.resolve({ message, source: "message" });

    expect(first.thread_ts).toBe("9");
    expect(second.thread_ts).toBe("9");
    expect(historyMock).toHaveBeenCalledTimes(1);
    nowSpy.mockReturnValue(1_700_000_060_000);
    expect((await resolver.resolve({ message, source: "message" })).thread_ts).toBe("9");
    expect(historyMock).toHaveBeenCalledTimes(2);
  });

  it("classifies an exhausted real WebClient 429 as transient", async () => {
    const fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        headers: { "content-type": "application/json", "retry-after": "0" },
        status: 429,
      });
    });
    const client = new WebClient("xoxb-test", {
      fetch,
      retryConfig: { retries: 0 },
      slackApiUrl: "https://slack.test/api/",
    });

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

  it.each(["internal_error"])(
    "classifies a real WebClient %s platform response as transient",
    async (code) => {
      const fetch = vi.fn(async () => {
        return Response.json({ ok: false, error: code });
      });
      const client = new WebClient("xoxb-test", {
        fetch,
        retryConfig: { retries: 0 },
        slackApiUrl: "https://slack.test/api/",
      });

      const error: unknown = await client.users
        .info({ user: "U1" })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(WebAPIPlatformError);
      expect(isTransientSlackThreadLookupError(error)).toBe(true);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      label: "an actual Slack rate-limit error",
      error: new WebAPIRateLimitedError(1),
    },
  ])("hands $label to durable ingress without poisoning the cache", async ({ error }) => {
    const historyMock = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ messages: [{ ts: "1", thread_ts: "9" }] });
    const resolver = createSlackThreadTsResolver({
      client: createThreadClient(historyMock),
    });
    const message = makeThreadReplyMessage("1");
    const turnAdoptionLifecycle = createDurableTurnLifecycle();

    await expect(
      resolver.resolve({ message, source: "message", turnAdoptionLifecycle }),
    ).rejects.toBe(error);
    await expect(
      resolver.resolve({ message, source: "app_mention", turnAdoptionLifecycle }),
    ).resolves.toMatchObject({ thread_ts: "9" });

    expect(historyMock).toHaveBeenCalledTimes(2);
  });

  it("keeps direct transient failures ambiguous without poisoning their future lookup", async () => {
    const historyMock = vi
      .fn()
      .mockRejectedValueOnce(new WebAPIHTTPError(503, "Service Unavailable", {}, "outage"))
      .mockResolvedValueOnce({ messages: [{ ts: "1", thread_ts: "9" }] });
    const resolver = createSlackThreadTsResolver({
      client: createThreadClient(historyMock),
    });
    const message = makeThreadReplyMessage("1");

    await expect(resolver.resolve({ message, source: "message" })).resolves.toMatchObject({
      _ambiguousThreadReply: true,
    });
    await expect(resolver.resolve({ message, source: "app_mention" })).resolves.toMatchObject({
      thread_ts: "9",
    });

    expect(historyMock).toHaveBeenCalledTimes(2);
  });

  it("releases all coalesced durable twins for their existing queue retry", async () => {
    let rejectHistory!: (error: unknown) => void;
    const historyMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectHistory = reject;
          }),
      )
      .mockResolvedValueOnce({ messages: [{ ts: "1", thread_ts: "9" }] });
    const resolver = createSlackThreadTsResolver({
      client: createThreadClient(historyMock),
    });
    const message = makeThreadReplyMessage("1");
    const firstLifecycle = createDurableTurnLifecycle();
    const secondLifecycle = createDurableTurnLifecycle();
    const first = resolver.resolve({
      message,
      source: "message",
      turnAdoptionLifecycle: firstLifecycle,
    });
    const second = resolver.resolve({
      message,
      source: "app_mention",
      turnAdoptionLifecycle: secondLifecycle,
    });
    const outage = new WebAPIHTTPError(503, "Service Unavailable", {}, "outage");

    expect(historyMock).toHaveBeenCalledTimes(1);
    rejectHistory(outage);
    await expect(Promise.allSettled([first, second])).resolves.toEqual([
      { status: "rejected", reason: outage },
      { status: "rejected", reason: outage },
    ]);
    await expect(
      resolver.resolve({ message, source: "message", turnAdoptionLifecycle: firstLifecycle }),
    ).resolves.toMatchObject({ thread_ts: "9" });
    expect(historyMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: "Slack platform missing_scope",
      error: new WebAPIPlatformError({ ok: false, error: "missing_scope" }),
    },
    {
      label: "unclassified local failure",
      error: new Error("local lookup unavailable"),
    },
    {
      label: "uncoded Slack request failure",
      error: new WebAPIRequestError(new Error("request failed without a transient signal")),
    },
  ])("preserves cached ambiguity for definitive $label", async ({ error }) => {
    const historyMock = vi.fn().mockRejectedValue(error);
    const resolver = createSlackThreadTsResolver({
      client: createThreadClient(historyMock),
    });
    const message = makeThreadReplyMessage("1");
    const turnAdoptionLifecycle = createDurableTurnLifecycle();

    await expect(
      resolver.resolve({ message, source: "message", turnAdoptionLifecycle }),
    ).resolves.toMatchObject({ _ambiguousThreadReply: true });
    await expect(
      resolver.resolve({ message, source: "app_mention", turnAdoptionLifecycle }),
    ).resolves.toMatchObject({ _ambiguousThreadReply: true });
    expect(historyMock).toHaveBeenCalledTimes(1);
  });
});

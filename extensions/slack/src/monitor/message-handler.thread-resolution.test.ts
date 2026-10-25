import { text } from "node:stream/consumers";
import { App } from "@slack/bolt";
import {
  WebClient,
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
} from "@slack/web-api";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../types.js";
import type { SlackIngressTurnLifecycle } from "./ingress.types.js";
import { createMonitorTestContext } from "./monitor-context.test-support.js";
import { createSlackThreadTsResolver } from "./thread-resolution.js";
import { isTransientSlackApiError } from "./transient-api-error.js";
const enqueue = vi.hoisted(() => vi.fn(async (_entry: unknown) => {}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  createChannelInboundDebouncer: () => ({
    debounceMs: 0,
    debouncer: {
      enqueue,
      flushKey: async () => {},
      cancelKey: () => false,
      drain: async () => {},
    },
  }),
}));

const { createSlackMessageHandler } = await import("./message-handler.js");

describe("Slack message handler thread resolution", () => {
  it("coalesces Enterprise lookups and retains separate caches for replacement and default clients", async () => {
    enqueue.mockClear();
    const requests: Array<{ path?: string; token?: string; body: string }> = [];
    await withServer(
      (request, response) => {
        void text(request).then((body) => {
          requests.push({
            path: request.url,
            token: request.headers.authorization,
            body,
          });
          const root = request.headers.authorization?.endsWith("replacement") ? "100.2" : "100.1";
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true, messages: [{ ts: "100.3", thread_ts: root }] }));
        });
      },
      async (baseUrl) => {
        const clientOptions = { slackApiUrl: `${baseUrl}/api/`, retryConfig: { retries: 0 } };
        const client = (token: string) => new WebClient(token, clientOptions);
        const app = new App({
          token: "synthetic-default",
          signingSecret: "synthetic-signing-secret",
          tokenVerificationEnabled: false,
          clientOptions,
        });
        const listenerClient = client("synthetic-listener");
        const replacementClient = client("synthetic-replacement");
        const handler = createSlackMessageHandler({
          ctx: createMonitorTestContext({ cfg: {}, accountId: "thread-test", app }),
        });
        const message: SlackMessageEvent = {
          type: "message",
          channel: "C111",
          user: "U111",
          parent_user_id: "U222",
          ts: "100.3",
          text: "thread reply",
        };
        const eventScope = { teamId: "T111", client: listenerClient };
        await Promise.all([
          handler(message, { source: "message", eventScope }),
          handler(message, { source: "app_mention", eventScope }),
        ]);
        await handler(message, { source: "message", eventScope });
        expect(requests).toHaveLength(1);
        expect(enqueue).toHaveBeenCalledTimes(3);
        for (const [entry] of enqueue.mock.calls) {
          expect(entry).toMatchObject({ message: { thread_ts: "100.1" } });
        }

        await handler(message, {
          source: "message",
          eventScope: { teamId: "T111", client: replacementClient },
        });
        expect(requests).toHaveLength(2);
        expect(enqueue).toHaveBeenLastCalledWith(
          expect.objectContaining({ message: expect.objectContaining({ thread_ts: "100.2" }) }),
        );

        await Promise.all([
          handler(message, { source: "message" }),
          handler(message, { source: "app_mention" }),
        ]);
        await handler(message, { source: "message" });
        expect(requests).toHaveLength(3);
        expect(requests.map((request) => request.token)).toEqual([
          "Bearer synthetic-listener",
          "Bearer synthetic-replacement",
          "Bearer synthetic-default",
        ]);
        for (const request of requests) {
          expect(request.path).toBe("/api/conversations.history");
          expect(Object.fromEntries(new URLSearchParams(request.body))).toMatchObject({
            channel: "C111",
            latest: "100.3",
            oldest: "100.3",
            inclusive: "true",
            limit: "1",
          });
        }
      },
    );
  });
});

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

  it.each(["429", "internal_error"] as const)(
    "classifies a real WebClient %s as transient",
    async (failure) => {
      const fetch = vi.fn(async () =>
        failure === "429"
          ? new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
              headers: { "content-type": "application/json", "retry-after": "0" },
              status: 429,
            })
          : Response.json({ ok: false, error: "internal_error" }),
      );
      const error: unknown = await createWebClient(fetch)
        .users.info({ user: "U1" })
        .catch((caught: unknown) => caught);
      if (failure === "429") {
        expect(error).toBeInstanceOf(WebAPIRequestError);
        if (!(error instanceof WebAPIRequestError)) {
          throw new Error("expected exhausted Slack 429 to become WebAPIRequestError");
        }
        expect(error.original.message).toMatch(
          /^A rate limit was exceeded \(url: .+, retry-after: 0\)$/,
        );
      } else {
        expect(error).toBeInstanceOf(WebAPIPlatformError);
      }
      expect(isTransientSlackApiError(error)).toBe(true);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("retries a malformed Retry-After response without caching a missing thread", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(Response.json({ ok: true, messages: [{ ts: "1", thread_ts: "9" }] }));
    const resolver = createSlackThreadTsResolver({ client: createWebClient(fetch) });
    const request = {
      message: { type: "message" as const, channel: "C1", parent_user_id: "U2", ts: "1" },
      source: "message" as const,
      turnAdoptionLifecycle: createDurableTurnLifecycle(),
    };

    await expect(resolver.resolve(request)).rejects.toThrow(
      /^Retry header did not contain a valid timeout \(url: .+, retry-after header: null\)$/,
    );
    await expect(resolver.resolve(request)).resolves.toMatchObject(resolved);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { error: new WebAPIRateLimitedError(1), durable: true },
    { error: new WebAPIHTTPError(503, "Service Unavailable", {}, "outage"), durable: false },
  ])("does not cache transient lookup failures (durable=$durable)", async ({ error, durable }) => {
    const historyMock = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ messages: [{ ts: "1", thread_ts: "9" }] });
    const resolve = createResolver(historyMock);
    const lifecycle = durable ? createDurableTurnLifecycle() : undefined;
    const first = resolve("message", lifecycle);
    if (durable) {
      await expect(first).rejects.toBe(error);
    } else {
      await expect(first).resolves.toMatchObject(ambiguous);
    }
    await expect(resolve("app_mention", lifecycle)).resolves.toMatchObject(resolved);
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

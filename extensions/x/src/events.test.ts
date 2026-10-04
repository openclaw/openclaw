import { afterEach, describe, expect, it, vi } from "vitest";
import { createXApiClient, type XPost, type XPostEnvelope } from "./api.js";
import { runXEvents, type XEventStatus } from "./events.js";

const post = (id: string): XPost => ({
  id,
  text: "@bot hello",
  author_id: "7",
  conversation_id: "1",
  entities: { mentions: [{ id: "9", username: "bot" }] },
});

afterEach(() => {
  vi.useRealTimers();
});

describe("X event transport", () => {
  it("admits every page in order before advancing the cursor and retains it on admission failure", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const failed = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    let cursor = "10";
    let fail = true;
    const order: string[] = [];
    const api = createXApiClient({
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh",
      saveRefreshToken: async () => {},
      fetch: async (input) => {
        const url = new URL(input);
        if (url.pathname.endsWith("/oauth2/token")) {
          return Response.json({ access_token: "access" });
        }
        expect(url.searchParams.get("since_id")).toBe("10");
        return Response.json(
          url.searchParams.has("pagination_token")
            ? { data: [post("11")], meta: { newest_id: "11" } }
            : { data: [post("13"), post("12")], meta: { newest_id: "13", next_token: "next" } },
        );
      },
    });
    const run = runXEvents({
      api,
      userId: "9",
      signal: abort.signal,
      bearerConfigured: false,
      getCursor: async () => cursor,
      setCursor: async (id: string) => {
        order.push(`cursor:${id}`);
        cursor = id;
      },
      onPost: async ({ post: mention }: { post: XPost }) => {
        order.push(`append:${mention.id}`);
        if (fail && mention.id === "12") {
          throw new Error("disk unavailable");
        }
      },
      onStatus: (value) => {
        if (value.message === "mentions poll failed; retrying after the poll interval") {
          failed.resolve();
        }
        if (value.cursor === "13") {
          completed.resolve();
        }
      },
    });
    try {
      await failed.promise;
      expect(cursor).toBe("10");
      expect(order).toEqual(["append:11", "append:12"]);
      fail = false;
      order.length = 0;
      await vi.advanceTimersByTimeAsync(60_000);
      await completed.promise;
      expect(order).toEqual(["append:11", "append:12", "append:13", "cursor:13"]);
    } finally {
      abort.abort();
      await run;
    }
  });

  it("filters app-wide recipients before advancing the cursor and backfills after an idle reconnect", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const firstConnected = Promise.withResolvers<void>();
    const reconnected = Promise.withResolvers<void>();
    const firstAdmitted = Promise.withResolvers<void>();
    const secondAdmitted = Promise.withResolvers<void>();
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const admitted: string[] = [];
    const envelopes: XPostEnvelope[] = [];
    const lookups: string[] = [];
    const backfills: (string | null)[] = [];
    const statuses: XEventStatus[] = [];
    let cursor = "10";
    const encoder = new TextEncoder();
    const api = createXApiClient({
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh",
      bearerToken: "bearer",
      saveRefreshToken: async () => {},
      fetch: async (input) => {
        const url = new URL(input);
        if (url.pathname.endsWith("/oauth2/token")) {
          return Response.json({ access_token: "access" });
        }
        if (url.pathname.endsWith("/subscriptions")) {
          return Response.json({
            data: [{ event_type: "post.mention.create", filter: { user_id: "9" } }],
          });
        }
        if (url.pathname.endsWith("/stream")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streams.push(controller);
              },
            }),
          );
        }
        if (url.pathname === "/2/tweets") {
          const id = url.searchParams.get("ids")!;
          lookups.push(id);
          return Response.json({
            data: [
              {
                ...post(id),
                entities: {
                  mentions: [
                    id === "50" ? { id: "99", username: "bot" } : { id: "9", username: "BOT" },
                  ],
                },
              },
            ],
            includes: { users: [{ id: "7", username: "maintainer", name: "Maintainer" }] },
          });
        }
        backfills.push(url.searchParams.get("since_id"));
        return Response.json({ data: backfills.length === 2 ? [post("21")] : [] });
      },
    });
    const run = runXEvents({
      api,
      userId: "9",
      signal: abort.signal,
      bearerConfigured: true,
      getCursor: async () => cursor,
      setCursor: async (id) => {
        cursor = id;
      },
      onStatus: (value) => {
        statuses.push(value);
        if (value.streamConnected) {
          (streams.length === 1 ? firstConnected : reconnected).resolve();
        }
      },
      onPost: async (envelope) => {
        envelopes.push(envelope);
        admitted.push(envelope.post.id);
        (envelope.post.id === "20" ? firstAdmitted : secondAdmitted).resolve();
      },
    });
    try {
      await firstConnected.promise;
      streams[0]!.enqueue(
        encoder.encode(`${JSON.stringify({ data: { ...post("50"), entities: undefined } })}\n`),
      );
      const event = JSON.stringify({
        event_type: "post.mention.create",
        data: { ...post("20"), entities: undefined },
      });
      streams[0]!.enqueue(encoder.encode(`\n${event.slice(0, 15)}`));
      streams[0]!.enqueue(encoder.encode(`${event.slice(15)}\n\n`));
      await firstAdmitted.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(admitted).toEqual(["20"]);
      expect(cursor).toBe("20");
      expect(lookups).toEqual(["50", "20"]);
      expect(envelopes[0]?.users).toEqual([
        { id: "7", username: "maintainer", name: "Maintainer" },
      ]);
      await vi.advanceTimersByTimeAsync(20_000);
      streams[0]!.enqueue(encoder.encode("\n"));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(streams).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(6_000);
      await reconnected.promise;
      await secondAdmitted.promise;
      expect(admitted).toEqual(["20", "21"]);
      expect(backfills).toEqual(["10", "20"]);
      expect(statuses).toContainEqual(expect.objectContaining({ streamBackoffMs: 1000 }));
    } finally {
      abort.abort();
      await run;
    }
  });

  it.each([
    { label: "absent entities", entities: undefined },
    { label: "URL-only entities", entities: { urls: [{ url: "https://example.com" }] } },
  ])("hydrates recipient evidence for stream posts with $label", async ({ entities }) => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const consumed = Promise.withResolvers<void>();
    const admitted: XPostEnvelope[] = [];
    const lookups: string[] = [];
    let cursor: string | undefined;
    const api = createXApiClient({
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "seed",
      bearerToken: "bearer",
      saveRefreshToken: async () => {},
      fetch: async (input) => {
        const url = new URL(input);
        if (url.pathname.endsWith("/oauth2/token")) {
          return Response.json({ access_token: "access" });
        }
        if (url.pathname.endsWith("/subscriptions")) {
          return Response.json({
            data: [{ event_type: "post.mention.create", filter: { user_id: "9" } }],
          });
        }
        if (url.pathname.endsWith("/stream")) {
          return new Response(`${JSON.stringify({ data: { ...post("20"), entities } })}\n`);
        }
        if (url.pathname === "/2/tweets") {
          lookups.push(url.searchParams.get("ids")!);
          return Response.json({
            data: [post("20")],
            includes: { users: [{ id: "7", username: "maintainer" }] },
          });
        }
        return Response.json({ data: [] });
      },
    });
    const run = runXEvents({
      api,
      userId: "9",
      signal: abort.signal,
      bearerConfigured: true,
      getCursor: async () => cursor,
      setCursor: async (id) => {
        cursor = id;
      },
      onPost: async (envelope) => {
        admitted.push(envelope);
      },
      onStatus: (value) => {
        if (value.message === "activity stream reconnect backoff") {
          consumed.resolve();
        }
      },
    });
    try {
      await consumed.promise;
      expect(admitted.map((envelope) => envelope.post.id)).toEqual(["20"]);
      expect(cursor).toBe("20");
      expect(lookups).toEqual(["20"]);
      expect(admitted[0]?.users).toEqual([{ id: "7", username: "maintainer" }]);
    } finally {
      abort.abort();
      await run;
    }
  });

  it.each([
    { endpoint: "subscriptions", failure: 403, mode: "stream", shouldPoll: true },
    { endpoint: "stream", failure: 403, mode: "stream", shouldPoll: true },
    { endpoint: "subscriptions", failure: 401, mode: "auto", shouldPoll: true },
    { endpoint: "subscriptions", failure: "network", mode: "auto", shouldPoll: true },
    { endpoint: "subscriptions", failure: 401, mode: "stream", shouldPoll: false },
    { endpoint: "subscriptions", failure: "network", mode: "stream", shouldPoll: false },
  ] as const)(
    "handles Activity $endpoint $failure in $mode mode",
    async ({ endpoint, failure, mode, shouldPoll }) => {
      const abort = new AbortController();
      const polled = Promise.withResolvers<void>();
      const statuses: XEventStatus[] = [];
      const api = createXApiClient({
        clientId: "client",
        clientSecret: "secret",
        refreshToken: "refresh",
        bearerToken: "bearer",
        saveRefreshToken: async () => {},
        fetch: async (input) => {
          if (input.endsWith(`/${endpoint}`)) {
            if (failure === "network") {
              throw new Error("Synthetic Activity transport failure");
            }
            return new Response(null, { status: failure });
          }
          if (input.endsWith("/subscriptions")) {
            return Response.json({
              data: [{ event_type: "post.mention.create", filter: { user_id: "9" } }],
            });
          }
          if (input.endsWith("/oauth2/token")) {
            return Response.json({ access_token: "access" });
          }
          polled.resolve();
          return Response.json({ data: [] });
        },
      });
      const run = runXEvents({
        api,
        userId: "9",
        mode,
        signal: abort.signal,
        bearerConfigured: true,
        getCursor: async () => undefined,
        setCursor: async () => {},
        onPost: async () => {},
        onStatus: (value) => statuses.push(value),
      });
      if (!shouldPoll) {
        await expect(run).rejects.toThrow(
          failure === "network" ? "X API network request failed" : "HTTP 401",
        );
        expect(statuses.some((value) => value.eventMode === "poll")).toBe(false);
        return;
      }
      void run.catch((error: unknown) => polled.reject(error));
      try {
        await polled.promise;
      } finally {
        abort.abort();
        await run;
      }
      expect(statuses).toContainEqual(
        expect.objectContaining({
          eventMode: "poll",
          message: "activity API unavailable for this app; polling",
        }),
      );
    },
  );
});

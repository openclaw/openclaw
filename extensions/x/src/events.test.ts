import { responseWithRelease } from "openclaw/plugin-sdk/fetch-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createXApiClient, type XApiClient, type XPost, type XPostEnvelope } from "./api.js";
import { runXEvents, type XCursorState, type XEventStatus } from "./events.js";
import { createXTestSpend } from "./test-support/spend.js";

const post = (id: string): XPost => ({
  id,
  text: "@bot hello",
  author_id: "7",
  conversation_id: "1",
  entities: { mentions: [{ id: "9", username: "bot" }] },
});

function budgetApi(
  spend: XApiClient["spend"],
  respond: (url: URL) => Response | Promise<Response>,
) {
  return createXApiClient({
    spend,
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
      return respond(url);
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("X event transport", () => {
  it("makes no paid poll while exhausted and resumes at midnight from the unchanged cursor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T23:59:00Z"));
    const abort = new AbortController();
    const paused = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    const spend = createXTestSpend({ dailyUsd: 0.15 });
    await spend.charge(5_000);
    let cursor: XCursorState = { sinceId: "10" };
    const polls: (string | null)[] = [];
    const api = budgetApi(spend, (url) => {
      polls.push(url.searchParams.get("since_id"));
      expect(url.searchParams.get("max_results")).toBe("10");
      return Response.json({ data: [post("11")] });
    });
    const run = runXEvents({
      api,
      userId: "9",
      signal: abort.signal,
      bearerConfigured: false,
      getCursor: async () => cursor,
      setCursor: async (id) => {
        cursor = id;
        resumed.resolve();
      },
      onPost: async () => {},
      onStatus: (value) => {
        if (value.spend?.exhaustedUntil) {
          expect(value.message).toBe(
            "X API daily budget of $0.15 reached; resumes at 2026-10-06T00:00Z",
          );
          paused.resolve();
        }
      },
    });
    try {
      await paused.promise;
      expect(polls).toEqual([]);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(polls).toEqual([]);
      expect(cursor.sinceId).toBe("10");
      await vi.advanceTimersByTimeAsync(1);
      await resumed.promise;
      expect(polls).toEqual(["10"]);
      expect(cursor.sinceId).toBe("11");
    } finally {
      abort.abort();
      await run;
    }
  });

  it("closes on reserved headroom and keeps polling until reset even when the reservation releases", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T23:59:00Z"));
    const abort = new AbortController();
    const connected = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const polled = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    const spend = createXTestSpend({ dailyUsd: 1 });
    let connections = 0;
    let polls = 0;
    const api = budgetApi(spend, (url) => {
      if (url.pathname.endsWith("/stream")) {
        connections++;
        return new Response(new ReadableStream<Uint8Array>({ cancel: () => closed.resolve() }));
      }
      polls++;
      return Response.json({ data: [] });
    });
    const getMentions = api.getMentions;
    vi.spyOn(api, "getMentions").mockImplementation(async (params) => {
      const page = await getMentions(params);
      if (polls === 2) {
        polled.resolve();
      }
      return page;
    });
    const run = runXEvents({
      api,
      userId: "9",
      signal: abort.signal,
      bearerConfigured: true,
      getCursor: async () => ({ sinceId: "10" }),
      setCursor: async () => {},
      onPost: async () => {},
      onStatus: (value) => {
        if (value.streamConnected) {
          (connections === 1 ? connected : resumed).resolve();
        }
      },
    });
    try {
      await connected.promise;
      await vi.advanceTimersByTimeAsync(0);
      const reserved = await spend.reserve(510_000);
      await closed.promise;
      await reserved.settle(0);
      await polled.promise;
      expect((await spend.status()).dayUsd).toBe(0);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(connections).toBe(1);
      expect(polls).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      await resumed.promise;
      expect(connections).toBe(2);
    } finally {
      abort.abort();
      await run;
    }
  });

  it.each(["backfill", "recipient"] as const)(
    "captures all buffered chunks before budget closure while %s is held",
    async (heldOperation) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-05T23:59:00Z"));
      const abort = new AbortController();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      const bodiesReleased = Promise.withResolvers<void>();
      const polled = Promise.withResolvers<void>();
      const resumed = Promise.withResolvers<void>();
      const spend = createXTestSpend({ dailyUsd: 1 });
      const admitted: string[] = [];
      let cursor: XCursorState = { sinceId: "10" };
      let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
      let connections = 0;
      let polls = 0;
      let releasedBodies = 0;
      const releaseBody = async () => {
        if (++releasedBodies === 2) {
          bodiesReleased.resolve();
        }
      };
      const chunk = (id: string, hydrate = false) =>
        new TextEncoder().encode(
          `${JSON.stringify({
            event_type: "post.mention.create",
            data: { ...post(id), ...(hydrate ? { entities: undefined } : {}) },
          })}\n`,
        );
      const api = budgetApi(spend, async (url) => {
        if (url.pathname.endsWith("/stream")) {
          connections++;
          const response = new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                stream = controller;
                if (connections === 1) {
                  controller.enqueue(chunk("20", true));
                  controller.enqueue(chunk("21"));
                }
              },
              cancel: () => closed.resolve(),
            }),
          );
          // Real fetch responses pass through asynchronous SDK body wrappers.
          return responseWithRelease(responseWithRelease(response, releaseBody), releaseBody);
        }
        if (url.pathname === "/2/tweets") {
          if (heldOperation === "recipient") {
            entered.resolve();
            await release.promise;
          }
          return Response.json({ data: [post("20")] });
        }
        if (++polls === 1 && heldOperation === "backfill") {
          entered.resolve();
          await release.promise;
        }
        return Response.json({ data: [] });
      });
      const getMentions = api.getMentions;
      vi.spyOn(api, "getMentions").mockImplementation(async (params) => {
        const page = await getMentions(params);
        if (polls === 2) {
          polled.resolve();
        }
        return page;
      });
      const run = runXEvents({
        api,
        userId: "9",
        signal: abort.signal,
        bearerConfigured: true,
        getCursor: async () => cursor,
        setCursor: async (next) => {
          cursor = next;
        },
        onPost: async ({ post: mention }) => {
          admitted.push(mention.id);
        },
        onStatus: (value) => {
          if (value.streamConnected && connections === 2) {
            resumed.resolve();
          }
        },
      });
      try {
        await entered.promise;
        stream!.enqueue(chunk("22"));
        stream!.enqueue(chunk("23"));
        stream!.enqueue(chunk("24"));
        await spend.charge(600_000);
        await Promise.all([closed.promise, bodiesReleased.promise]);
        expect(releasedBodies).toBe(2);
        expect(admitted).toEqual([]);
        expect((await spend.status()).dayUsd).toBe(heldOperation === "backfill" ? 0.78 : 0.64);
        release.resolve();
        await polled.promise;
        expect(admitted).toEqual(["20", "21", "22", "23", "24"]);
        expect(cursor).toEqual({ sinceId: "24" });
        expect((await spend.status()).dayUsd).toBe(0.63);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(connections).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        await resumed.promise;
        expect(connections).toBe(2);
      } finally {
        release.resolve();
        abort.abort();
        await run;
      }
    },
  );

  it("charges ignored events and preserves the entire received burst after the budget closes its stream", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
    const abort = new AbortController();
    const paused = Promise.withResolvers<void>();
    const spend = createXTestSpend({ dailyUsd: 0.65 });
    const delivered = [
      ...Array.from({ length: 125 }, () => ({ event_type: "post.create" })),
      { event_type: "post.mention.create", data: { ...post("800"), author_id: "9" } },
      {
        event_type: "post.mention.create",
        data: { ...post("801"), entities: { mentions: [{ id: "99", username: "other" }] } },
      },
      { event_type: "post.mention.create", data: { ...post("900"), entities: undefined } },
      { event_type: "post.mention.create", data: post("20") },
      { event_type: "post.mention.create", data: post("21") },
      { event_type: "post.delete" },
    ];
    const admitted: XPostEnvelope[] = [];
    let cursor: XCursorState = { sinceId: "10" };
    let cancelled = false;
    const api = budgetApi(spend, (url) => {
      if (url.pathname.endsWith("/stream")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  delivered.map((event) => JSON.stringify(event)).join("\n") + "\n",
                ),
              );
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      }
      expect(url.pathname).toBe("/2/users/9/mentions");
      return Response.json({ data: [] });
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
        if (value.spend?.exhaustedUntil) {
          paused.resolve();
        }
      },
    });
    try {
      await paused.promise;
      expect(cancelled).toBe(true);
      expect(admitted.map((envelope) => envelope.post.id)).toEqual(["900", "20", "21"]);
      expect(admitted[0]?.recipientPending).toBe(true);
      expect(cursor.sinceId).toBe("21");
      expect((await spend.status()).dayUsd).toBe(0.66);
    } finally {
      abort.abort();
      await run;
    }
  });

  it("resumes older backfill pages after restart and reset without skipping its already-paid batch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T23:59:59Z"));
    const paused = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const spend = createXTestSpend({ dailyUsd: 0.65 });
    const admitted: string[] = [];
    const tokens: (string | null)[] = [];
    let cursor: XCursorState = { sinceId: "10" };
    let connections = 0;
    const api = budgetApi(spend, (url) => {
      if (url.pathname.endsWith("/stream")) {
        connections++;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              if (connections === 1) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `${JSON.stringify({ event_type: "post.mention.create", data: post("100") })}\n`,
                  ),
                );
              }
            },
          }),
        );
      }
      expect(url.searchParams.get("since_id")).toBe("10");
      const token = url.searchParams.get("pagination_token");
      tokens.push(token);
      const pageIndex = Number(token ?? "0");
      const offset = 51 - pageIndex * 10;
      return Response.json({
        data: Array.from({ length: 10 }, (_, index) => post(String(offset + 9 - index))),
        includes: {
          users: Array.from({ length: 10 }, (_, index) => ({
            id: String(offset + index),
            username: `user${index}`,
          })),
        },
        meta: pageIndex < 4 ? { next_token: String(pageIndex + 1) } : {},
      });
    });
    const firstBatch = Array.from({ length: 40 }, (_, index) => String(21 + index));
    const start = () => {
      const abort = new AbortController();
      const run = runXEvents({
        api,
        userId: "9",
        signal: abort.signal,
        bearerConfigured: true,
        getCursor: async () => structuredClone(cursor),
        setCursor: async (next) => {
          if (next.backfill) {
            expect(admitted.slice(0, 40)).toEqual(firstBatch);
          }
          cursor = structuredClone(next);
        },
        onPost: async ({ post: mention }) => {
          admitted.push(mention.id);
        },
        onStatus: (value) => {
          if (value.spend?.exhaustedUntil) {
            paused.resolve();
          }
          if (value.cursor === "60") {
            completed.resolve();
          }
        },
      });
      return { abort, run };
    };
    const first = start();
    let second: ReturnType<typeof start> | undefined;
    try {
      await paused.promise;
      expect(tokens).toEqual([null, "1", "2", "3"]);
      expect(admitted).toEqual([...firstBatch, "100"]);
      expect(cursor).toEqual({
        sinceId: "10",
        backfill: { sinceId: "10", paginationToken: "4", newestId: "60" },
      });
      expect((await spend.status()).dayUsd).toBe(0.61);
      first.abort.abort();
      await first.run;
      vi.setSystemTime(new Date("2026-10-06T00:00:00Z"));
      second = start();
      await completed.promise;
      expect(tokens).toEqual([null, "1", "2", "3", "4"]);
      expect(admitted).toEqual([
        ...firstBatch,
        "100",
        ...Array.from({ length: 10 }, (_, index) => String(11 + index)),
      ]);
      expect(cursor).toEqual({ sinceId: "60" });
      expect((await spend.status()).dayUsd).toBe(0.15);
    } finally {
      first.abort.abort();
      second?.abort.abort();
      await Promise.all([first.run, second?.run]);
    }
  });

  it.each([
    { mode: "stale", tokens: [null], finalId: "11", retainsContinuation: false },
    { mode: "rejected", tokens: ["saved", null], finalId: "50", retainsContinuation: false },
    { mode: "forbidden", tokens: ["saved"], finalId: "10", retainsContinuation: true },
    {
      mode: "rejected-twice",
      tokens: ["saved", null, "fresh"],
      finalId: "10",
      retainsContinuation: false,
    },
  ] as const)("recovers $mode backfill without an unbounded token retry", async (testCase) => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const settled = Promise.withResolvers<void>();
    const tokens: (string | null)[] = [];
    let cursor: XCursorState = {
      sinceId: "10",
      backfill: {
        sinceId: testCase.mode === "stale" ? "9" : "10",
        paginationToken: "saved",
        newestId: "50",
      },
    };
    const original = structuredClone(cursor);
    const api = budgetApi(createXTestSpend(), (url) => {
      expect(url.searchParams.get("since_id")).toBe("10");
      const token = url.searchParams.get("pagination_token");
      tokens.push(token);
      if (testCase.mode === "forbidden") {
        return new Response(null, { status: 403 });
      }
      if (token && (testCase.mode === "rejected" || testCase.mode === "rejected-twice")) {
        return new Response(null, { status: 400 });
      }
      return Response.json({
        data: [post("11")],
        meta: testCase.mode === "rejected-twice" ? { next_token: "fresh" } : {},
      });
    });
    const run = runXEvents({
      api,
      userId: "9",
      signal: abort.signal,
      bearerConfigured: false,
      getCursor: async () => cursor,
      setCursor: async (next) => {
        cursor = next;
      },
      onPost: async () => {},
      onStatus: (value) => {
        if (
          value.cursor ||
          value.message === "mentions poll failed; retrying after the poll interval"
        ) {
          settled.resolve();
        }
      },
    });
    try {
      await settled.promise;
      expect(tokens).toEqual(testCase.tokens);
      expect(cursor).toEqual(
        testCase.retainsContinuation ? original : { sinceId: testCase.finalId },
      );
    } finally {
      abort.abort();
      await run;
    }
  });

  it("admits every page in order before advancing the cursor and retains it on admission failure", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const failed = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    let cursor: XCursorState = { sinceId: "10" };
    let fail = true;
    const order: string[] = [];
    const api = createXApiClient({
      spend: createXTestSpend(),
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
      setCursor: async (next) => {
        order.push(`cursor:${next.sinceId}`);
        cursor = next;
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
      expect(cursor).toEqual({ sinceId: "10" });
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
    let cursor: XCursorState = { sinceId: "10" };
    const encoder = new TextEncoder();
    const api = createXApiClient({
      spend: createXTestSpend(),
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
      expect(cursor.sinceId).toBe("20");
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
    let cursor: XCursorState = {};
    const api = createXApiClient({
      spend: createXTestSpend(),
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
      expect(cursor.sinceId).toBe("20");
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
        spend: createXTestSpend(),
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
        getCursor: async () => ({}),
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

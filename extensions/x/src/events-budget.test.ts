import { responseWithRelease } from "openclaw/plugin-sdk/fetch-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { XPostEnvelope } from "./api.js";
import { runXEvents, type XCursorState } from "./events.js";
import { budgetApi, post } from "./test-support/events.js";
import { createXTestSpend } from "./test-support/spend.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("X budgeted event transport", () => {
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

  it("settles and admits a paid periodic backfill after its stream closes for budget headroom", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
    const abort = new AbortController();
    const initial = Promise.withResolvers<void>();
    const periodic = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const polled = Promise.withResolvers<void>();
    const spend = createXTestSpend({ dailyUsd: 1 });
    const admitted: string[] = [];
    let cursor: XCursorState = { sinceId: "10" };
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let periodicSignal: AbortSignal | null | undefined;
    let polls = 0;
    let connections = 0;
    const api = budgetApi(spend, async (url, init) => {
      if (url.pathname.endsWith("/stream")) {
        connections++;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
            },
            cancel: () => closed.resolve(),
          }),
        );
      }
      if (++polls === 2) {
        periodicSignal = init?.signal;
        periodic.resolve();
        await release.promise;
        return Response.json({ data: [post("11")] });
      }
      return Response.json({ data: [] });
    });
    const getMentions = api.getMentions;
    vi.spyOn(api, "getMentions").mockImplementation(async (params) => {
      const page = await getMentions(params);
      if (polls === 1) {
        initial.resolve();
      }
      if (polls === 3) {
        polled.resolve();
      }
      return page;
    });
    const run = runXEvents({
      api,
      userId: "9",
      signal: abort.signal,
      bearerConfigured: true,
      pollSeconds: 15,
      getCursor: async () => cursor,
      setCursor: async (next) => {
        cursor = next;
      },
      onPost: async ({ post: mention }) => {
        admitted.push(mention.id);
      },
    });
    try {
      await initial.promise;
      for (let index = 0; index < 3; index++) {
        await vi.advanceTimersByTimeAsync(20_000);
        stream!.enqueue(new TextEncoder().encode("\n"));
      }
      await periodic.promise;
      await spend.charge(510_000);
      await closed.promise;
      expect(periodicSignal).toBeDefined();
      expect(periodicSignal?.aborted).toBe(false);
      expect(polls).toBe(2);
      expect(admitted).toEqual([]);
      release.resolve();
      await polled.promise;
      expect(admitted).toEqual(["11"]);
      expect(cursor).toEqual({ sinceId: "11" });
      expect((await spend.status()).dayUsd).toBe(0.52);
      expect(connections).toBe(1);
    } finally {
      release.resolve();
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

  it("retains a paid polling page and resumes its continuation after a later HTTP 503", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T23:58:00Z"));
    const abort = new AbortController();
    const failed = Promise.withResolvers<void>();
    const paused = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const admitted: string[] = [];
    const tokens: (string | null)[] = [];
    let cursor: XCursorState = { sinceId: "10" };
    const api = budgetApi(createXTestSpend({ dailyUsd: 0.3 }), (url) => {
      tokens.push(url.searchParams.get("pagination_token"));
      if (tokens.length === 2) {
        return Response.json({}, { status: 503 });
      }
      return Response.json(
        tokens.length === 1
          ? {
              data: Array.from({ length: 10 }, (_, index) => post(String(20 - index))),
              includes: {
                users: Array.from({ length: 10 }, (_, index) => ({
                  id: String(20 - index),
                  username: `user${index}`,
                })),
              },
              meta: { next_token: "older" },
            }
          : { data: [] },
      );
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
      onPost: async ({ post: mention }) => {
        admitted.push(mention.id);
      },
      onStatus: (value) => {
        if (value.message === "mentions poll failed; retrying after the poll interval") {
          failed.resolve();
        }
        if (value.spend?.exhaustedUntil) {
          paused.resolve();
        }
        if (value.cursor === "20") {
          completed.resolve();
        }
      },
    });
    try {
      await failed.promise;
      expect(admitted).toEqual(Array.from({ length: 10 }, (_, index) => String(11 + index)));
      expect(cursor).toEqual({
        sinceId: "10",
        backfill: { sinceId: "10", paginationToken: "older", newestId: "20" },
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await paused.promise;
      expect(tokens).toEqual([null, "older"]);
      await vi.advanceTimersByTimeAsync(60_000);
      await completed.promise;
      expect(tokens).toEqual([null, "older", "older"]);
      expect(cursor).toEqual({ sinceId: "20" });
    } finally {
      abort.abort();
      await run;
    }
  });

  it.each([
    { label: "backfill", heldOperation: "backfill", failure: 0, malformed: false },
    { label: "recipient", heldOperation: "recipient", failure: 0, malformed: false },
    { label: "HTTP 429 backfill", heldOperation: "backfill", failure: 429, malformed: false },
    { label: "HTTP 503 backfill", heldOperation: "backfill", failure: 503, malformed: false },
    { label: "HTTP 503 recipient", heldOperation: "recipient", failure: 503, malformed: false },
    { label: "malformed batch", heldOperation: "backfill", failure: 0, malformed: true },
  ] as const)(
    "captures all buffered chunks before budget closure while $label is held",
    async ({ heldOperation, failure, malformed }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-05T23:59:00Z"));
      const abort = new AbortController();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      const bodiesReleased = Promise.withResolvers<void>();
      const polled = Promise.withResolvers<void>();
      const resumed = Promise.withResolvers<void>();
      const backoff = Promise.withResolvers<void>();
      const spend = createXTestSpend({ dailyUsd: 1 });
      const admitted: string[] = [];
      const envelopes: XPostEnvelope[] = [];
      let cursor: XCursorState = { sinceId: "10" };
      let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
      let connections = 0;
      let polls = 0;
      let lookups = 0;
      let releasedBodies = 0;
      const releaseBody = async () => {
        if (++releasedBodies === 2) {
          bodiesReleased.resolve();
        }
      };
      const chunk = (id: string, hydrate = false) =>
        new TextEncoder().encode(
          `${JSON.stringify({
            data: {
              event_type: "post.mention.create",
              payload: { ...post(id), ...(hydrate ? { entities: undefined } : {}) },
            },
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
          lookups++;
          if (heldOperation === "recipient") {
            entered.resolve();
            await release.promise;
            if (failure) {
              return Response.json({}, { status: failure });
            }
          }
          return Response.json({ data: [post("20")] });
        }
        if (++polls === 1 && heldOperation === "backfill") {
          entered.resolve();
          await release.promise;
          if (failure) {
            return Response.json({}, { status: failure });
          }
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
        onPost: async (envelope) => {
          admitted.push(envelope.post.id);
          envelopes.push(envelope);
        },
        onStatus: (value) => {
          if (value.streamConnected && connections === 2) {
            resumed.resolve();
          }
          if (value.message === "activity stream reconnect backoff") {
            backoff.resolve();
          }
        },
      });
      try {
        await entered.promise;
        const third = chunk("22", heldOperation === "recipient" && Boolean(failure));
        stream!.enqueue(
          malformed
            ? new TextEncoder().encode(`${new TextDecoder().decode(third)}not-json\n`)
            : third,
        );
        stream!.enqueue(chunk("23"));
        stream!.enqueue(chunk("24"));
        await spend.charge(600_000);
        await Promise.all([closed.promise, bodiesReleased.promise]);
        expect(releasedBodies).toBe(2);
        expect(admitted).toEqual([]);
        expect((await spend.status()).dayUsd).toBe(heldOperation === "backfill" ? 0.78 : 0.64);
        release.resolve();
        const failed = Boolean(failure);
        const expectedCursor = "10";
        if (failed) {
          await backoff.promise;
          expect(admitted).toEqual(["20", "21", "22", "23", "24"]);
          expect(cursor).toEqual({ sinceId: expectedCursor });
          await vi.advanceTimersByTimeAsync(1_000);
        }
        await polled.promise;
        expect(admitted).toEqual(["20", "21", "22", "23", "24"]);
        expect(cursor).toEqual({ sinceId: expectedCursor });
        if (heldOperation === "recipient" && failure) {
          expect(envelopes.every((envelope) => envelope.recipientPending)).toBe(true);
          expect(lookups).toBe(1);
        }
        expect((await spend.status()).dayUsd).toBe(
          failure === 503 ? (heldOperation === "recipient" ? 0.64 : 0.78) : 0.63,
        );
        await vi.advanceTimersByTimeAsync(failed ? 58_999 : 59_999);
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
      ...Array.from({ length: 125 }, () => ({ data: { event_type: "post.create" } })),
      { data: { event_type: "post.mention.create", payload: { ...post("800"), author_id: "9" } } },
      {
        data: {
          event_type: "post.mention.create",
          payload: { ...post("801"), entities: { mentions: [{ id: "99", username: "other" }] } },
        },
      },
      {
        data: {
          event_type: "post.mention.create",
          payload: { ...post("900"), entities: undefined },
        },
      },
      {
        data: {
          event_type: "post.mention.create",
          payload: post("20"),
          includes: { users: [{ id: "7", username: "maintainer" }] },
        },
      },
      { data: { event_type: "post.mention.create", payload: post("21") } },
      { data: { event_type: "post.delete" } },
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
      expect(admitted[1]?.users).toEqual([{ id: "7", username: "maintainer" }]);
      expect(cursor.sinceId).toBe("10");
      expect((await spend.status()).dayUsd).toBe(0.67);
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
                    `${JSON.stringify({ data: { event_type: "post.mention.create", payload: post("100") } })}\n`,
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
});

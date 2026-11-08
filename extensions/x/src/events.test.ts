import { afterEach, describe, expect, it, vi } from "vitest";
import { X_ACTIVITY_POST_EVENT_TYPES, type XPostEnvelope } from "./api.js";
import { runXEvents, type XCursorState, type XEventStatus } from "./events.js";
import { createXTestApi as createXApiClient } from "./test-support/api-client.js";
import { budgetApi, post } from "./test-support/events.js";
import { createXTestSpend } from "./test-support/spend.js";

const event = (payload: unknown, event_type = "post.mention.create") =>
  JSON.stringify({ data: { event_type, payload } });

function streamFixture({
  source,
  abort = new AbortController(),
  ...options
}: Partial<Omit<Parameters<typeof runXEvents>[0], "signal">> & {
  source?: UnderlyingDefaultSource<Uint8Array>;
  abort?: AbortController;
} = {}) {
  const admitted: XPostEnvelope[] = [];
  const statuses: XEventStatus[] = [];
  const warning = vi.fn();
  const connected = Promise.withResolvers<void>();
  const encoder = new TextEncoder();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const api =
    options.api ??
    budgetApi(createXTestSpend(), (url) =>
      url.pathname.endsWith("/stream")
        ? new Response(
            new ReadableStream<Uint8Array>(
              source ?? {
                start: (value) => {
                  stream = value;
                },
              },
            ),
          )
        : Response.json({ data: [] }),
    );
  const run = runXEvents({
    api,
    userId: "9",
    signal: abort.signal,
    bearerConfigured: true,
    getCursor: async () => ({}),
    setCursor: async () => {},
    ...options,
    onPost: async (envelope) => {
      admitted.push(envelope);
      await options.onPost?.(envelope);
    },
    onStatus: (value) => {
      statuses.push(value);
      if (value.streamConnected) {
        connected.resolve();
      }
      options.onStatus?.(value);
    },
    onWarning: (message) => {
      warning(message);
      options.onWarning?.(message);
    },
  });
  void run.catch(connected.reject);
  void connected.promise.catch(() => {});
  return {
    connected: connected.promise,
    admitted,
    statuses,
    run,
    warning,
    send: (...lines: string[]) =>
      lines.forEach((line) => stream.enqueue(encoder.encode(`${line}\n`))),
    stop: async () => {
      abort.abort();
      await run;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("X event transport", () => {
  it("times retry sleep, both budget checks, response headers, and first byte separately", async () => {
    vi.useFakeTimers();
    const delay = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
    const spend = createXTestSpend();
    const budgetStarted = Promise.withResolvers<void>();
    vi.spyOn(spend, "streamResumeAt").mockImplementation(async () => {
      budgetStarted.resolve();
      await delay(125);
      return undefined;
    });
    let attempt = 0;
    const api = budgetApi(spend, async (url) => {
      if (!url.pathname.endsWith("/stream")) {
        return Response.json({ data: [] });
      }
      if (++attempt === 1) {
        await delay(20_000);
        return Response.json({}, { status: 503 });
      }
      await delay(20);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => controller.enqueue(new TextEncoder().encode("\n")), 30);
          },
        }),
      );
    });
    const onStreamTiming = vi.fn();
    const test = streamFixture({ api, onStreamTiming });
    try {
      await budgetStarted.promise;
      await vi.advanceTimersByTimeAsync(21_520);
      await test.connected;
      expect(onStreamTiming.mock.calls).toEqual([
        ["budget-preflight", 125],
        ["budget-check", 125],
        ["response-headers", 20_000],
        ["backoff", 1_000],
        ["budget-preflight", 125],
        ["budget-check", 125],
        ["response-headers", 20],
      ]);
      await vi.advanceTimersByTimeAsync(30);
      expect(onStreamTiming).toHaveBeenLastCalledWith("first-byte", 30);
    } finally {
      await test.stop();
    }
  });

  it("backs off consecutive failed opens but resets after each connected stream", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const failed = Promise.withResolvers<void>();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const api = budgetApi(createXTestSpend(), (url) => {
      if (!url.pathname.endsWith("/stream")) {
        return Response.json({ data: [] });
      }
      if (++attempt <= 3) {
        return Response.json({}, { status: 503 });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (value) => {
            stream = value;
          },
        }),
      );
    });
    const test = streamFixture({
      api,
      onStatus: (value) => {
        if (value.streamBackoffMs) {
          failed.resolve();
        }
      },
    });
    const waits = () =>
      test.statuses.flatMap((value) => (value.streamBackoffMs ? [value.streamBackoffMs] : []));
    try {
      await failed.promise;
      for (const delay of [1_000, 2_000, 4_000]) {
        expect(waits().at(-1)).toBe(delay);
        await vi.advanceTimersByTimeAsync(delay);
      }
      await test.connected;
      for (let drop = 0; drop < 7; drop++) {
        stream.close();
        await vi.advanceTimersByTimeAsync(0);
        expect(waits().at(-1)).toBe(1_000);
        await vi.advanceTimersByTimeAsync(999);
        expect(attempt).toBe(4 + drop);
        await vi.advanceTimersByTimeAsync(1);
        expect(attempt).toBe(5 + drop);
      }
    } finally {
      await test.stop();
    }
  });

  it.each([true, false])(
    "checks buffered data after a synchronous stall (data=%s)",
    async (hasData) => {
      // Keep immediates real: advancing timers synchronously holds promise jobs and
      // the simulated socket delivery until after the overdue idle callback runs.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const test = streamFixture();
      try {
        await test.connected;
        await vi.advanceTimersByTimeAsync(0);
        const delivery = new Promise<void>((resolve) => {
          setImmediate(resolve);
        }).then(() => {
          if (hasData) {
            test.send(event(post("20")));
          }
        });
        vi.advanceTimersByTime(27_800);
        await delivery;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(test.statuses.some((value) => value.streamConnected === false)).toBe(!hasData);
        expect(test.admitted.map((value) => value.post.id)).toEqual(hasData ? ["20"] : []);
        if (hasData) {
          await vi.advanceTimersByTimeAsync(25_000);
          expect(test.statuses).toContainEqual(expect.objectContaining({ streamBackoffMs: 1_000 }));
        }
      } finally {
        await test.stop();
      }
    },
  );

  it("warns once per unparseable streak without event content and clears on a good event", async () => {
    vi.useFakeTimers();
    const test = streamFixture();
    const bad = JSON.stringify({
      data: { event_type: "post.mention.create", payload: { text: "private content" } },
      errors: [],
    });
    const ignored = JSON.stringify({ data: { event_type: "post.create", payload: post("19") } });
    try {
      await test.connected;
      test.send(ignored, ignored, ignored, ignored);
      await vi.advanceTimersByTimeAsync(0);
      expect(test.warning).not.toHaveBeenCalled();
      expect(test.admitted).toEqual([]);
      test.send(bad, "", ignored, bad);
      await vi.advanceTimersByTimeAsync(0);
      expect(test.warning).not.toHaveBeenCalled();
      test.send(bad);
      await vi.advanceTimersByTimeAsync(0);
      expect(test.warning).toHaveBeenCalledOnce();
      test.send(bad, ignored);
      await vi.advanceTimersByTimeAsync(0);
      expect(test.warning).toHaveBeenCalledOnce();
      const message = test.warning.mock.calls[0]![0];
      expect(message).toContain('type="post.mention.create"');
      expect(message).toContain('keys=["data","errors"]');
      expect(message).not.toContain("private content");
      expect(test.statuses.at(-1)?.message).toBe(message);
      test.send(event(post("20")));
      await vi.advanceTimersByTimeAsync(0);
      expect(test.statuses).toContainEqual({ message: "activity stream connected" });
      test.send(bad, bad, "invalid JSON");
      await vi.advanceTimersByTimeAsync(0);
      expect(test.admitted).toHaveLength(1);
      expect(test.warning).toHaveBeenCalledTimes(2);
    } finally {
      await test.stop();
    }
  });

  it.each([
    { mode: "stale", tokens: [null], finalId: "11", continuation: null },
    { mode: "rejected", tokens: ["saved", null], finalId: "50", continuation: null },
    { mode: "forbidden", tokens: ["saved"], finalId: "10", continuation: "saved" },
    { mode: "repeated", tokens: ["saved"], finalId: "10", continuation: null },
    {
      mode: "rejected-twice",
      tokens: ["saved", null, "fresh"],
      finalId: "10",
      continuation: null,
    },
  ] as const)("recovers $mode backfill without an unbounded token retry", async (testCase) => {
    vi.useFakeTimers();
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
        meta:
          testCase.mode === "rejected-twice"
            ? { next_token: "fresh" }
            : testCase.mode === "repeated"
              ? { next_token: "saved" }
              : {},
      });
    });
    const test = streamFixture({
      api,
      bearerConfigured: false,
      getCursor: async () => cursor,
      setCursor: async (next) => {
        cursor = next;
      },
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
      expect(test.admitted.map((item) => item.post.id)).toEqual(
        testCase.mode === "forbidden" ? [] : ["11"],
      );
      expect(cursor).toEqual({
        sinceId: testCase.finalId,
        ...(testCase.continuation
          ? {
              backfill: { sinceId: "10", paginationToken: testCase.continuation, newestId: "50" },
            }
          : {}),
      });
    } finally {
      await test.stop();
    }
  });

  it("admits every page in order before advancing the cursor and retains it on admission failure", async () => {
    vi.useFakeTimers();
    const failed = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    let cursor: XCursorState = { sinceId: "10" };
    let fail = true;
    const order: string[] = [];
    const api = budgetApi(createXTestSpend(), (url) => {
      expect(url.searchParams.get("since_id")).toBe("10");
      return Response.json(
        url.searchParams.has("pagination_token")
          ? { data: [post("11")], meta: { newest_id: "11" } }
          : { data: [post("13"), post("12")], meta: { newest_id: "13", next_token: "next" } },
      );
    });
    const test = streamFixture({
      api,
      bearerConfigured: false,
      getCursor: async () => cursor,
      setCursor: async (next) => {
        order.push(`cursor:${next.sinceId}`);
        cursor = next;
      },
      onPost: async ({ post: mention }) => {
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
      await test.stop();
    }
  });

  it.each([
    { label: "absent entities", entities: undefined, sinceId: "10" },
    {
      label: "URL-only entities",
      entities: { urls: [{ url: "https://example.com" }] },
      sinceId: undefined,
    },
  ])(
    "hydrates $label mentions and backfills after an idle reconnect",
    async ({ entities, sinceId }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const firstConnected = Promise.withResolvers<void>();
      const reconnected = Promise.withResolvers<void>();
      const firstAdmitted = Promise.withResolvers<void>();
      const secondAdmitted = Promise.withResolvers<void>();
      const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
      const lookups: string[] = [];
      const backfills: (string | null)[] = [];
      let cursor: XCursorState = { sinceId };
      const encoder = new TextEncoder();
      const api = budgetApi(createXTestSpend(), (url) => {
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
      });
      const test = streamFixture({
        api,
        getCursor: async () => cursor,
        setCursor: async (id) => {
          cursor = id;
        },
        onStatus: (value) => {
          if (value.streamConnected) {
            (streams.length === 1 ? firstConnected : reconnected).resolve();
          }
        },
        onPost: async (envelope) => {
          (envelope.post.id === "20" ? firstAdmitted : secondAdmitted).resolve();
        },
      });
      try {
        await firstConnected.promise;
        streams[0]!.enqueue(encoder.encode(`${event(post("49"), "post.create")}\n`));
        streams[0]!.enqueue(encoder.encode(`${event({ ...post("50"), entities: undefined })}\n`));
        const message = event({ ...post("20"), entities });
        streams[0]!.enqueue(encoder.encode(`\n${message.slice(0, 15)}`));
        streams[0]!.enqueue(encoder.encode(`${message.slice(15)}\n\n`));
        await firstAdmitted.promise;
        await vi.advanceTimersByTimeAsync(0);
        expect(test.admitted.map((item) => item.post.id)).toEqual(["20"]);
        expect(cursor.sinceId).toBe(sinceId);
        expect(lookups).toEqual(["50", "20"]);
        expect(test.admitted[0]?.users).toEqual([
          { id: "7", username: "maintainer", name: "Maintainer" },
        ]);
        await vi.advanceTimersByTimeAsync(20_000);
        streams[0]!.enqueue(encoder.encode("\n"));
        await vi.advanceTimersByTimeAsync(20_000);
        expect(streams).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(6_000);
        await reconnected.promise;
        await secondAdmitted.promise;
        expect(test.admitted.map((item) => item.post.id)).toEqual(["20", "21"]);
        expect(backfills).toEqual([sinceId ?? null, sinceId ?? null]);
        expect(test.statuses).toContainEqual(expect.objectContaining({ streamBackoffMs: 1000 }));
      } finally {
        await test.stop();
      }
    },
  );

  it.each([
    { endpoint: "subscriptions", failure: 403, mode: "stream", shouldPoll: true },
    { endpoint: "stream", failure: 403, mode: "stream", shouldPoll: true },
    { endpoint: "stream", failure: 401, mode: "auto", shouldPoll: true },
    { endpoint: "stream", failure: 401, mode: "stream", shouldPoll: true },
    { endpoint: "create", failure: 400, mode: "auto", shouldPoll: true },
    { endpoint: "subscriptions", failure: 401, mode: "auto", shouldPoll: true },
    { endpoint: "subscriptions", failure: "network", mode: "auto", shouldPoll: true },
    { endpoint: "subscriptions", failure: 401, mode: "stream", shouldPoll: false },
    { endpoint: "subscriptions", failure: "network", mode: "stream", shouldPoll: false },
    { endpoint: "subscriptions", failure: "abort", mode: "stream", shouldPoll: false },
  ] as const)(
    "handles Activity $endpoint $failure in $mode mode",
    async ({ endpoint, failure, mode, shouldPoll }) => {
      vi.useFakeTimers();
      const abort = new AbortController();
      const polled = Promise.withResolvers<void>();
      const api = createXApiClient({
        clientSecret: "test-client-secret",
        refreshToken: "test-refresh-token",
        bearerToken: "test-app-bearer",
        fetch: async (input, init) => {
          if (
            input.endsWith(`/${endpoint}`) ||
            (endpoint === "create" && input.endsWith("/subscriptions") && init?.method === "POST")
          ) {
            if (failure === "abort") {
              abort.abort();
              throw abort.signal.reason;
            }
            if (failure === "network") {
              throw new Error("Synthetic Activity transport failure");
            }
            return Response.json(
              {
                errors: [
                  {
                    message:
                      "OauthAccessTokenRequired: OAuth user access token is required for this event type",
                  },
                  { message: "Do not expose subsequent errors" },
                ],
              },
              { status: failure },
            );
          }
          if (input.endsWith("/subscriptions")) {
            return Response.json({
              data:
                endpoint === "create"
                  ? []
                  : X_ACTIVITY_POST_EVENT_TYPES.map((event_type) => ({
                      event_type,
                      filter: { user_id: "9" },
                    })),
            });
          }
          if (input.endsWith("/oauth2/token")) {
            return Response.json({ access_token: "test-user-access" });
          }
          polled.resolve();
          return Response.json({ data: [] });
        },
      });
      const { run, statuses, stop } = streamFixture({ api, mode, abort });
      if (failure === "abort") {
        await expect(run).resolves.toBeUndefined();
        expect(statuses).toEqual([]);
        return;
      }
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
        await stop();
      }
      expect(statuses.at(-1)).toMatchObject({
        eventMode: "poll",
        message:
          failure === "network"
            ? "X API network request failed; polling"
            : `X API /2/activity/${endpoint === "create" ? "subscriptions" : endpoint} failed (HTTP ${failure}): OauthAccessTokenRequired: OAuth user access token is required for this event type; polling`,
      });
    },
  );

  it.each([
    { label: "many small events", events: 180, text: "hello", maxReadsWhileHeld: 48 },
    { label: "fewer large events", events: 24, text: "x".repeat(240_000), maxReadsWhileHeld: 12 },
  ])(
    "bounds queued $label while preserving FIFO delivery",
    async ({ events, text, maxReadsWhileHeld }) => {
      vi.useFakeTimers();
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<void>();
      const admitted: string[] = [];
      let reads = 0;
      const encoder = new TextEncoder();
      const test = streamFixture({
        source: {
          pull(controller) {
            if (reads === events) {
              controller.close();
            } else {
              controller.enqueue(encoder.encode(`${event({ ...post(String(++reads)), text })}\n`));
            }
          },
        },
        onPost: async ({ post: mention }) => {
          if (!admitted.length) {
            held.resolve();
            await release.promise;
          }
          admitted.push(mention.id);
          if (admitted.length === events) {
            finished.resolve();
          }
        },
      });
      void test.run.catch((error: unknown) => {
        held.reject(error);
        finished.reject(error);
      });
      try {
        await held.promise;
        await vi.advanceTimersByTimeAsync(0);
        const buffered = reads;
        await vi.advanceTimersByTimeAsync(0);
        expect(admitted).toEqual([]);
        expect(buffered).toBeGreaterThan(1);
        expect(buffered).toBeLessThanOrEqual(maxReadsWhileHeld);
        expect(reads).toBe(buffered);
        release.resolve();
        await finished.promise;
        expect(admitted).toEqual(Array.from({ length: events }, (_, index) => String(index + 1)));
        expect(reads).toBe(events);
      } finally {
        release.resolve();
        await test.stop();
      }
    },
  );
});

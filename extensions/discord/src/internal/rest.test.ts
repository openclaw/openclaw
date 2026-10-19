import { gzipSync } from "node:zlib";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiscordRetryRunner } from "../retry.js";
import { serializeRequestBody } from "./rest-body.js";
import { RateLimitError, RequestClient } from "./rest.js";
import { createJsonResponse } from "./test-builders.test-support.js";

async function expectRateLimitError(promise: Promise<unknown>, expected: { retryAfter: number }) {
  await expect(promise).rejects.toBeInstanceOf(RateLimitError);
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toMatchObject({ name: "RateLimitError", retryAfter: expected.retryAfter });
}

function queuedResponses(...responses: Response[]) {
  const pending = responses.map((response) => Promise.resolve(response));
  return vi.fn(async () => {
    const response = pending.shift();
    if (!response) {
      throw new Error("unexpected request");
    }
    return await response;
  });
}

function bucketResponse(
  id: string,
  bucket: string,
  remaining = "1",
  extra: Record<string, string> = {},
) {
  const headers = {
    "X-RateLimit-Bucket": bucket,
    "X-RateLimit-Remaining": remaining,
    ...extra,
  };
  return createJsonResponse({ id }, { headers });
}

function rateLimitResponse(
  retryAfter: number | string,
  headers: Record<string, string>,
  global = false,
) {
  return createJsonResponse(
    { message: "Rate limited", retry_after: retryAfter, global },
    { status: 429, headers },
  );
}

function requestClient(
  fetch: typeof globalThis.fetch,
  options: Omit<NonNullable<ConstructorParameters<typeof RequestClient>[1]>, "fetch"> = {},
) {
  return new RequestClient("test-token", { fetch, ...options });
}

function streamClient(source: UnderlyingSource<Uint8Array>, timeout?: number) {
  return requestClient(async () => new Response(new ReadableStream(source)), {
    queueRequests: false,
    timeout,
  });
}

function fakeClock() {
  vi.useFakeTimers();
  vi.setSystemTime(0);
}

describe("RequestClient", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { status: 404, method: "post" },
    { status: 429, method: "post" },
    { status: 503, method: "post" },
  ] as const)(
    "preserves $status retry policy for $method with an unreadable error body",
    async ({ status, method }) => {
      const fetchSpy = vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull() {
                throw new TypeError("network error");
              },
            }),
            { status, headers: { "retry-after": "0" } },
          ),
      );
      const client = new RequestClient("", { fetch: fetchSpy, queueRequests: false });
      const retry = createDiscordRetryRunner({
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      });
      await expect(retry(() => client[method]("/channels/c1/messages/m1"))).rejects.toMatchObject({
        status,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(status === 429 || status >= 500 ? 2 : 1);
    },
  );

  it("defaults non-finite REST client timeouts before scheduling requests", async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      expect(new URL(readRequestUrl(input)).pathname).toBe("/api/v10/guilds/g1/roles");
      return createJsonResponse({ ok: true });
    });
    const client = requestClient(fetchSpy, { timeout: Number.NaN });

    await expect(client.get("/guilds/g1/roles")).resolves.toEqual({ ok: true });
  });

  it("dispatches critical interaction callbacks before older background requests", async () => {
    const releaseWorkers = createDeferred<void>();
    const blockers = Array.from({ length: 4 }, (_, index) => `/guilds/blocked-${index}/roles`);
    const responses = new Map<string, Promise<Response>>([
      ["/interactions/123/token/callback", Promise.resolve(createJsonResponse({ ok: "critical" }))],
      ["/guilds/g2/roles", Promise.resolve(createJsonResponse({ ok: "background" }))],
    ]);
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = readRequestUrl(input);
      const path = new URL(url).pathname.replace(/^\/api\/v\d+/, "");
      if (blockers.includes(path)) {
        await releaseWorkers.promise;
        return createJsonResponse({ ok: "first" });
      }
      const response = responses.get(path);
      if (!response) {
        throw new Error(`unexpected request ${path}`);
      }
      return await response;
    });
    const client = requestClient(fetchSpy);

    const active = blockers.map((path) => client.get(path));
    const background = client.get("/guilds/g2/roles");
    const critical = client.post("/interactions/123/token/callback", { body: { type: 5 } });

    expect(fetchSpy).toHaveBeenCalledTimes(4);
    releaseWorkers.resolve();

    await Promise.all(active);
    await expect(critical).resolves.toEqual({ ok: "critical" });
    await expect(background).resolves.toEqual({ ok: "background" });
    expect(fetchSpy.mock.calls.map(([input]) => new URL(readRequestUrl(input)).pathname)).toEqual([
      ...blockers.map((path) => `/api/v10${path}`),
      "/api/v10/interactions/123/token/callback",
      "/api/v10/guilds/g2/roles",
    ]);
  });

  it("drops stale background requests instead of replaying obsolete reads", async () => {
    fakeClock();
    const firstResponse = createDeferred<Response>();
    const fetchSpy = vi.fn(async () => await firstResponse.promise);
    const client = requestClient(fetchSpy, { timeout: 30_000 });

    const first = client.get("/guilds/g1/roles");
    const stale = client.get("/guilds/g1/roles");
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(20_001);
    firstResponse.resolve(createJsonResponse({ ok: "first" }));

    await expect(first).resolves.toEqual({ ok: "first" });
    await expect(stale).rejects.toThrow(/Dropped stale background request/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(client.queueSize).toBe(0);
  });

  it("keeps standard mutations queued until Discord accepts or rejects them", async () => {
    fakeClock();
    const releaseWorkers = createDeferred<void>();
    const fetchSpy = vi.fn(async () => {
      if (fetchSpy.mock.calls.length <= 4) {
        await releaseWorkers.promise;
      }
      return createJsonResponse({ ok: true });
    });
    const client = requestClient(fetchSpy, { timeout: 30_000 });
    const active = Array.from({ length: 4 }, (_, index) =>
      client.post(`/channels/blocked-${index}/messages`, { body: { content: "hold" } }),
    );

    const requests = [
      client.post("/channels/c1/messages", { body: { content: "send" } }),
      client.patch("/channels/c1/messages/m1", { body: { content: "edit" } }),
      client.delete("/channels/c1/messages/m2"),
      client.post("/webhooks/app/token", { body: { content: "webhook send" } }),
      client.patch("/webhooks/app/token/messages/@original", {
        body: { content: "webhook edit" },
      }),
      client.delete("/webhooks/app/token/messages/@original"),
      client.post("/applications/app/commands", { body: { name: "ping" } }),
    ];
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(20_001);
    releaseWorkers.resolve();
    await Promise.all(active);

    await expect(Promise.all(requests)).resolves.toEqual(
      Array.from({ length: 7 }, () => ({ ok: true })),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(requests.length + active.length);
    expect(client.queueSize).toBe(0);
  });

  it("drains same-bucket requests when the active request finishes without polling", async () => {
    fakeClock();
    const firstResponse = createDeferred<Response>();
    const fetchSpy = vi.fn(async () =>
      fetchSpy.mock.calls.length === 1
        ? await firstResponse.promise
        : createJsonResponse({ id: "second" }),
    );
    const client = requestClient(fetchSpy);

    const first = client.get("/channels/c1/messages");
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const second = client.get("/channels/c1/messages");
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(20);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    firstResponse.resolve(createJsonResponse({ id: "first" }));

    await expect(first).resolves.toEqual({ id: "first" });
    await expect(second).resolves.toEqual({ id: "second" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs independent route buckets concurrently", async () => {
    const channelResponse = createDeferred<Response>();
    const guildResponse = createDeferred<Response>();
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = readRequestUrl(input);
      return await (url.includes("/channels/") ? channelResponse.promise : guildResponse.promise);
    });
    const client = requestClient(fetchSpy);

    const channel = client.get("/channels/c1/messages");
    const guild = client.get("/guilds/g1/roles");

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

    channelResponse.resolve(bucketResponse("channel", "channel-messages"));
    guildResponse.resolve(bucketResponse("guild", "guild-roles"));

    await expect(Promise.all([channel, guild])).resolves.toEqual([
      { id: "channel" },
      { id: "guild" },
    ]);
  });

  it.each(["bucket", "global"] as const)(
    "waits for a %s rate-limit reset before dispatching",
    async (kind) => {
      fakeClock();
      const nextId = kind === "bucket" ? "second" : "after-global";
      const fetchSpy = queuedResponses(
        kind === "bucket"
          ? bucketResponse("first", "channel-messages", "0", {
              "X-RateLimit-Reset-After": "0.1",
              "X-RateLimit-Limit": "1",
            })
          : rateLimitResponse(0.1, { "X-RateLimit-Global": "true" }, true),
        kind === "bucket"
          ? bucketResponse(nextId, "channel-messages", "1", { "X-RateLimit-Limit": "1" })
          : createJsonResponse({ id: nextId }),
      );
      const client = requestClient(fetchSpy);
      if (kind === "bucket") {
        await expect(client.get("/channels/c1/messages")).resolves.toEqual({ id: "first" });
      }
      const request = client.get("/channels/c1/messages");
      await Promise.resolve();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(99);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(request).resolves.toEqual({ id: nextId });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    },
  );

  it("does not requeue an active rate limit after the queue is cleared", async () => {
    const response = createDeferred<Response>();
    const fetchSpy = vi.fn(async () => {
      if (fetchSpy.mock.calls.length > 1) {
        throw new Error("unexpected retry after clearQueue");
      }
      return await response.promise;
    });
    const client = requestClient(fetchSpy);

    const request = client.get("/channels/c1/messages");
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(client.queueSize).toBe(1);

    client.clearQueue();
    expect(client.queueSize).toBe(1);

    response.resolve(rateLimitResponse(0, { "X-RateLimit-Bucket": "channel-messages" }));

    await expectRateLimitError(request, { retryAfter: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(client.queueSize).toBe(0);
  });

  it.each([
    { body: "9007199254741", header: "7", expected: 7 },
    { body: "1e3", header: "9007199254741", expected: 1 },
  ])(
    "resolves unsafe retry delay $body with Retry-After $header",
    async ({ body, header, expected }) => {
      const client = requestClient(async () => rateLimitResponse(body, { "Retry-After": header }), {
        queueRequests: false,
      });
      await expectRateLimitError(client.get("/channels/c1/messages"), { retryAfter: expected });
    },
  );

  it.each(["streamed", "gzip-compressed"] as const)(
    "bounds %s REST response bodies",
    async (encoding) => {
      let pullCount = 0;
      let cancelCount = 0;
      const client =
        encoding === "streamed"
          ? streamClient({
              pull(controller) {
                pullCount += 1;
                controller.enqueue(new TextEncoder().encode("x".repeat(4 * 1024 * 1024)));
              },
              cancel() {
                cancelCount += 1;
              },
            })
          : requestClient(
              async () =>
                new Response(
                  gzipSync(Buffer.from(JSON.stringify({ data: "x".repeat(8 * 1024 * 1024) }))),
                  { headers: { "Content-Encoding": "gzip", "Content-Type": "application/json" } },
                ),
              { queueRequests: false },
            );
      await expect(client.get("/channels/c1/messages")).rejects.toThrow(
        /Discord REST response body exceeds 8388608 bytes/,
      );
      if (encoding === "streamed") {
        expect(cancelCount).toBe(1);
        expect(pullCount).toBeLessThanOrEqual(4);
      }
    },
  );

  it("aborts stalled REST response bodies after the idle timeout", async () => {
    const encoder = new TextEncoder();
    let cancelReason: unknown;
    const client = streamClient(
      {
        start(controller) {
          controller.enqueue(encoder.encode("partial payload"));
        },
        cancel(reason) {
          cancelReason = reason;
        },
      },
      50,
    );

    await expect(client.get("/channels/c1/messages")).rejects.toThrow(
      "Discord REST response stalled: no data received for 50ms",
    );
    expect(cancelReason).toBeInstanceOf(Error);
    expect(cancelReason).toMatchObject({
      message: "Discord REST response stalled: no data received for 50ms",
    });
  });

  it("passes multipart uploads to fetch as FormData", async () => {
    const arrayBufferSpy = vi.spyOn(Blob.prototype, "arrayBuffer");
    const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toBeInstanceOf(Headers);
      expect((init!.headers as Headers).get("Content-Type")).toBeNull();
      expect(init?.body).toBeInstanceOf(FormData);
      return Response.json({ id: "msg" });
    });
    const client = requestClient(fetchSpy, { queueRequests: false });

    try {
      await expect(
        client.post("/channels/c1/messages", {
          body: {
            content: "file",
            files: [{ name: "a.txt", data: new Uint8Array([1]), contentType: "text/plain" }],
          },
        }),
      ).resolves.toEqual({ id: "msg" });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(arrayBufferSpy).not.toHaveBeenCalled();
    } finally {
      arrayBufferSpy.mockRestore();
    }
  });

  it("serializes form multipart uploads for sticker-style endpoints", () => {
    const headers = new Headers();
    const file = {
      fieldName: "file",
      name: "sticker.png",
      data: new Uint8Array([1]),
      contentType: "image/png",
    };
    const body = serializeRequestBody(
      {
        multipartStyle: "form",
        body: {
          name: "Sticker",
          tags: "tag",
          files: [file],
        },
      },
      headers,
    );

    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get("name")).toBe("Sticker");
    expect(form.get("tags")).toBe("tag");
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect(form.get("payload_json")).toBeNull();
  });
});

function readRequestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

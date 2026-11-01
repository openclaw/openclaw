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
  return vi.fn(async () => {
    const response = responses.shift();
    if (!response) {
      throw new Error("unexpected request");
    }
    return response;
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

function heldRequest(result: unknown = { ok: "second" }) {
  const response = createDeferred<Response>();
  const fetch = vi.fn(async () =>
    fetch.mock.calls.length === 1 ? await response.promise : createJsonResponse(result),
  );
  return { fetch, response };
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

  it("dispatches critical interaction callbacks before older background requests", async () => {
    const release = createDeferred<void>();
    const blockers = Array.from({ length: 4 }, (_, index) => `/guilds/blocked-${index}/roles`);
    const responses = new Map([
      ["/interactions/123/token/callback", "critical"],
      ["/guilds/g2/roles", "background"],
    ]);
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(readRequestUrl(input)).pathname.replace(/^\/api\/v\d+/, "");
      if (blockers.includes(path)) {
        await release.promise;
        return createJsonResponse({ ok: "first" });
      }
      const result = responses.get(path);
      if (!result) {
        throw new Error(`unexpected request ${path}`);
      }
      return createJsonResponse({ ok: result });
    });
    const client = requestClient(fetchSpy, { timeout: Number.NaN });
    const active = blockers.map((path) => client.get(path));
    const background = client.get("/guilds/g2/roles");
    const critical = client.post("/interactions/123/token/callback", { body: { type: 5 } });

    expect(fetchSpy).toHaveBeenCalledTimes(4);
    release.resolve();

    await Promise.all(active);
    await expect(critical).resolves.toEqual({ ok: "critical" });
    await expect(background).resolves.toEqual({ ok: "background" });
    expect(fetchSpy.mock.calls.map(([input]) => new URL(readRequestUrl(input)).pathname)).toEqual([
      ...blockers.map((path) => `/api/v10${path}`),
      "/api/v10/interactions/123/token/callback",
      "/api/v10/guilds/g2/roles",
    ]);
  });

  it.each(["get", "post", "patch", "delete"] as const)(
    "drains aged same-bucket %s requests on settlement without polling",
    async (method) => {
      vi.useFakeTimers({ now: 0 });
      const { response: firstResponse, fetch: fetchSpy } = heldRequest({ id: "second" });
      const client = requestClient(fetchSpy, { timeout: 30_000 });

      const first = client[method]("/channels/c1/messages");
      await Promise.resolve();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const second = client[method]("/channels/c1/messages");
      await Promise.resolve();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(20_001);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      firstResponse.resolve(createJsonResponse({ id: "first" }));

      await expect(first).resolves.toEqual({ id: "first" });
      await expect(second).resolves.toEqual({ id: "second" });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["bucket", "global"] as const)(
    "waits for a %s rate-limit reset before dispatching",
    async (kind) => {
      vi.useFakeTimers({ now: 0 });
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
      const cancel = vi.fn();
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(new TextEncoder().encode("x".repeat(4 * 1024 * 1024)));
      });
      const response =
        encoding === "streamed"
          ? new Response(new ReadableStream({ pull, cancel }))
          : new Response(
              gzipSync(Buffer.from(JSON.stringify({ data: "x".repeat(8 * 1024 * 1024) }))),
              { headers: { "Content-Encoding": "gzip", "Content-Type": "application/json" } },
            );
      const client = requestClient(async () => response, { queueRequests: false });
      await expect(client.get("/channels/c1/messages")).rejects.toThrow(
        /Discord REST response body exceeds 8388608 bytes/,
      );
      if (encoding === "streamed") {
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(pull.mock.calls.length).toBeLessThanOrEqual(4);
      }
    },
  );

  it("aborts stalled REST response bodies after the idle timeout", async () => {
    let cancelReason: unknown;
    const client = streamClient(
      {
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial payload"));
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
        body: { name: "Sticker", tags: "tag", files: [file] },
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

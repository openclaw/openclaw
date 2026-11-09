import { gzipSync } from "node:zlib";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiscordClient } from "../client.js";
import { serializeRequestBody } from "./rest-body.js";
import { RateLimitError, RequestClient } from "./rest.js";
import { createJsonResponse } from "./test-builders.test-support.js";

function requestClient(
  fetch: typeof globalThis.fetch,
  options: Omit<NonNullable<ConstructorParameters<typeof RequestClient>[1]>, "fetch"> = {},
) {
  return new RequestClient("test-token", { fetch, ...options });
}
function bucketResponse(id: string, remaining = "1", extra: Record<string, string> = {}) {
  const headers = {
    "X-RateLimit-Bucket": "channel-messages",
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
function heldRequest(result: unknown = { ok: "second" }) {
  const response = createDeferred<Response>();
  const fetch = vi.fn(async () =>
    fetch.mock.calls.length === 1 ? await response.promise : createJsonResponse(result),
  );
  return { fetch, response };
}
const messagePath = "/channels/c1/messages";
afterEach(() => vi.useRealTimers());

describe("RequestClient", () => {
  it.each([404, 429, 503])(
    "preserves %s retry policy with an unreadable error body",
    async (status) => {
      const fetch = vi.fn(
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
      const rest = requestClient(fetch, { queueRequests: false });
      const { request } = createDiscordClient({
        cfg: { channels: { discord: { token: "test-token" } } },
        rest,
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      });
      await expect(request(() => rest.post(messagePath + "/m1"))).rejects.toMatchObject({ status });
      expect(fetch).toHaveBeenCalledTimes(status === 429 || status >= 500 ? 2 : 1);
    },
  );

  it("dispatches critical interaction callbacks before older background requests", async () => {
    const release = createDeferred<void>();
    const blockers = Array.from({ length: 4 }, (_, index) => `/guilds/blocked-${index}/roles`);
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(new Request(input).url).pathname.replace(/^\/api\/v\d+/, "");
      if (blockers.includes(path)) {
        await release.promise;
        return createJsonResponse({ ok: "first" });
      }
      expect(["/interactions/123/token/callback", "/guilds/g2/roles"]).toContain(path);
      return createJsonResponse({
        ok: path.startsWith("/interactions/") ? "critical" : "background",
      });
    });
    const client = requestClient(fetch, { timeout: Number.NaN });
    const active = blockers.map((path) => client.get(path));
    const background = client.get("/guilds/g2/roles");
    const critical = client.post("/interactions/123/token/callback", { body: { type: 5 } });
    expect(fetch).toHaveBeenCalledTimes(4);
    release.resolve();
    await Promise.all(active);
    await expect(critical).resolves.toEqual({ ok: "critical" });
    await expect(background).resolves.toEqual({ ok: "background" });
    expect(fetch.mock.calls.map(([input]) => new URL(new Request(input).url).pathname)).toEqual([
      ...blockers.map((path) => `/api/v10${path}`),
      "/api/v10/interactions/123/token/callback",
      "/api/v10/guilds/g2/roles",
    ]);
  });

  it.each(["get", "post", "patch", "delete"] as const)(
    "drains aged same-bucket %s requests on settlement without polling",
    async (method) => {
      vi.useFakeTimers({ now: 0 });
      const { response, fetch } = heldRequest({ id: "second" });
      const client = requestClient(fetch, { timeout: 30_000 });
      const first = client[method](messagePath);
      await Promise.resolve();
      expect(fetch).toHaveBeenCalledTimes(1);
      const second = client[method](messagePath);
      await Promise.resolve();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(20_001);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
      response.resolve(createJsonResponse({ id: "first" }));
      await expect(first).resolves.toEqual({ id: "first" });
      await expect(second).resolves.toEqual({ id: "second" });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["bucket", "global"] as const)(
    "waits for a %s rate-limit reset before dispatching",
    async (kind) => {
      vi.useFakeTimers({ now: 0 });
      const nextId = kind === "bucket" ? "second" : "after-global";
      const responses = [
        kind === "bucket"
          ? bucketResponse("first", "0", {
              "X-RateLimit-Reset-After": "0.1",
              "X-RateLimit-Limit": "1",
            })
          : rateLimitResponse(0.1, { "X-RateLimit-Global": "true" }, true),
        kind === "bucket"
          ? bucketResponse(nextId, "1", { "X-RateLimit-Limit": "1" })
          : createJsonResponse({ id: nextId }),
      ];
      const fetch = vi.fn(async () => {
        const response = responses.shift();
        if (!response) {
          throw new Error("unexpected request");
        }
        return response;
      });
      const client = requestClient(fetch);
      if (kind === "bucket") {
        await expect(client.get(messagePath)).resolves.toEqual({ id: "first" });
      }
      const request = client.get(messagePath);
      await Promise.resolve();
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(99);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(request).resolves.toEqual({ id: nextId });
      expect(fetch).toHaveBeenCalledTimes(2);
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
      const pending = client.get(messagePath);
      await expect(pending).rejects.toBeInstanceOf(RateLimitError);
      await expect(pending).rejects.toMatchObject({ name: "RateLimitError", retryAfter: expected });
    },
  );

  it.each(["streamed", "gzip-compressed"] as const)(
    "bounds %s REST response bodies",
    async (encoding) => {
      const cancel = vi.fn();
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) =>
        controller.enqueue(new TextEncoder().encode("x".repeat(4 * 1024 * 1024))),
      );
      const response =
        encoding === "streamed"
          ? new Response(new ReadableStream({ pull, cancel }))
          : new Response(
              gzipSync(Buffer.from(JSON.stringify({ data: "x".repeat(8 * 1024 * 1024) }))),
              { headers: { "Content-Encoding": "gzip", "Content-Type": "application/json" } },
            );
      await expect(
        requestClient(async () => response, { queueRequests: false }).get(messagePath),
      ).rejects.toThrow(/Discord REST response body exceeds 8388608 bytes/);
      if (encoding === "streamed") {
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(pull.mock.calls.length).toBeLessThanOrEqual(4);
      }
    },
  );

  it.each([0, 0.1])(
    "does not hold interaction callbacks for a global rate limit (route wait %s)",
    async (routeWait) => {
      vi.useFakeTimers({ now: 0 });
      const first = createDeferred<Response>();
      const fetch = vi.fn(async () => {
        if (fetch.mock.calls.length === 1) {
          return await first.promise;
        }
        if (routeWait > 0 && fetch.mock.calls.length === 2) {
          return rateLimitResponse(routeWait, {});
        }
        if (fetch.mock.calls.length === (routeWait > 0 ? 3 : 2)) {
          return createJsonResponse({ ok: "callback" });
        }
        return createJsonResponse({ id: "after-global" });
      });
      const client = requestClient(fetch);
      const limited = client.get(messagePath);
      await Promise.resolve();
      expect(fetch).toHaveBeenCalledTimes(1);
      first.resolve(
        rateLimitResponse(5, { "X-RateLimit-Global": "true", "X-RateLimit-Scope": "global" }, true),
      );
      await vi.advanceTimersByTimeAsync(0);
      const callback = client.post("/interactions/123/token/callback", { body: { type: 6 } });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(2);
      if (routeWait > 0) {
        await vi.advanceTimersByTimeAsync(99);
        expect(fetch).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetch).toHaveBeenCalledTimes(3);
      }
      await expect(callback).resolves.toEqual({ ok: "callback" });
      const callbackRequests = routeWait > 0 ? 3 : 2;
      await vi.advanceTimersByTimeAsync(4_999 - routeWait * 1000);
      expect(fetch).toHaveBeenCalledTimes(callbackRequests);
      await vi.advanceTimersByTimeAsync(1);
      await expect(limited).resolves.toEqual({ id: "after-global" });
      expect(fetch).toHaveBeenCalledTimes(callbackRequests + 1);
    },
  );

  it("aborts stalled REST response bodies after the idle timeout", async () => {
    let cancelReason: unknown;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial payload"));
        },
        cancel(reason) {
          cancelReason = reason;
        },
      }),
    );
    const client = requestClient(async () => response, { queueRequests: false, timeout: 50 });
    await expect(client.get(messagePath)).rejects.toThrow(
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
      { multipartStyle: "form", body: { name: "Sticker", tags: "tag", files: [file] } },
      headers,
    );
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get("name")).toBe("Sticker");
    expect(form.get("tags")).toBe("tag");
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect(form.get("payload_json")).toBeNull();
  });

  it.each(["queued", "backoff", "pre-aborted"] as const)(
    "settles %s caller cancellation without dispatching a later request",
    async (mode) => {
      vi.useFakeTimers({ now: 0 });
      const controller = new AbortController();
      const fetch = vi.fn(async () => rateLimitResponse(120, { "Retry-After": "120" }));
      const rest = requestClient(fetch, {
        queueRequests: mode !== "backoff",
        callerSignal: mode === "backoff" ? undefined : controller.signal,
      });
      const { request } = createDiscordClient({
        cfg: { channels: { discord: { token: "test-token" } } },
        rest,
        callerSignal: controller.signal,
        retry: { attempts: 2, minDelayMs: 120_000, maxDelayMs: 120_000, jitter: 0 },
      });
      if (mode === "pre-aborted") {
        controller.abort();
      }
      const pending =
        mode === "backoff" ? request(() => rest.post(messagePath)) : rest.post(messagePath);
      const settled = vi.fn();
      void pending.then(settled, settled);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(mode === "pre-aborted" ? 0 : 1);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toHaveBeenCalledTimes(1);
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetch).toHaveBeenCalledTimes(mode === "pre-aborted" ? 0 : 1);
    },
  );
});

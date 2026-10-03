import { setImmediate } from "node:timers/promises";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { MAX_JSON_BYTES } from "./schema.js";
import { requestEvaluation } from "./transport.js";

const request = {
  apiKey: "synthetic-key",
  timeoutMs: 1000,
  body: { model: "jev-test", state: null, questions: { q: { type: "noul" as const } } },
};
function mockFetch(implementation: typeof globalThis.fetch) {
  const fetch = vi.fn(implementation);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("never follows redirects to a credential sink", async () => {
  const fetch = mockFetch(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://other.example/credential-sink" },
      }),
  );
  await expect(requestEvaluation(request)).rejects.toMatchObject({ reason: "transport" });
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[0]).toBe("https://api.typesafe.ai/v1/systemone");
});
it("bounds the serialized request including its model field", async () => {
  const fetch = mockFetch(async () => new Response());
  await expect(
    requestEvaluation({ ...request, body: { ...request.body, state: "x".repeat(MAX_JSON_BYTES) } }),
  ).rejects.toThrow("request exceeds");
  expect(fetch).not.toHaveBeenCalled();
});
it("keeps the deadline active after response headers", async () => {
  const cancelled = vi.fn();
  mockFetch(async () => new Response(new ReadableStream({ pull() {}, cancel: cancelled })));
  await expect(requestEvaluation({ ...request, timeoutMs: 25 })).rejects.toThrow(
    "TypeSafe evaluation timed out.",
  );
  expect(cancelled).toHaveBeenCalledOnce();
});
it("rejects cancellation concurrent with body EOF", async () => {
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(stream) {
        controller.abort("synthetic-private-reason");
        stream.close();
      },
    },
    { highWaterMark: 0 },
  );
  mockFetch(async () => new Response(body));
  await expect(requestEvaluation({ ...request, signal: controller.signal })).rejects.toThrow(
    "TypeSafe evaluation cancelled.",
  );
});
it("preserves bounded multi-chunk JSON responses", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('{"value":'));
      stream.enqueue(new TextEncoder().encode("0.37}"));
      stream.close();
    },
  });
  mockFetch(async () => new Response(body));
  await expect(requestEvaluation(request)).resolves.toEqual({ value: 0.37 });
});
it.each<{ status: number; reason: string; headers: HeadersInit; retryAfterMs?: number }>([
  { status: 401, reason: "authentication", headers: {}, retryAfterMs: undefined },
  { status: 413, reason: "unsupported-input", headers: {}, retryAfterMs: undefined },
  { status: 422, reason: "unsupported-input", headers: {}, retryAfterMs: undefined },
  {
    status: 429,
    reason: "rate-limited",
    headers: { "retry-after-ms": "250", "retry-after": "10" },
    retryAfterMs: 250,
  },
  {
    status: 429,
    reason: "rate-limited",
    headers: { "retry-after-ms": "invalid", "retry-after": "10" },
    retryAfterMs: 10000,
  },
  {
    status: 429,
    reason: "rate-limited",
    headers: { "retry-after": "invalid" },
    retryAfterMs: undefined,
  },
])(
  "classifies HTTP $status without consuming private bodies or retrying",
  async ({ status, reason, headers, retryAfterMs }) => {
    const pull = vi.fn(() => {
      throw new Error("synthetic credential and submitted state");
    });
    const cancel = vi.fn();
    const fetch = mockFetch(
      async () =>
        new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
          status,
          headers: new Headers(headers),
        }),
    );
    const error = await requestEvaluation(request).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "EvaluationError", reason, retryAfterMs });
    if (reason === "unsupported-input") {
      expect(error).toHaveProperty("message", "TypeSafe rejected the supplied input.");
    }
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain("synthetic credential");
  },
);

it.each([
  { status: 401, trigger: "http", reason: "authentication" },
  { status: 200, trigger: "abort", reason: "transport" },
  { status: 200, trigger: "abort-at-headers", reason: "transport" },
  { status: 200, trigger: "overflow", reason: "invalid-response" },
])(
  "joins capture cancellation and release concurrently for $trigger/$status",
  async ({ status, trigger, reason }) => {
    let finishCancellation!: () => void;
    const cancellationGate = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });
    let finishRelease!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    const nativeCancel = vi.fn(() => cancellationGate);
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          if (trigger === "overflow") {
            controller.enqueue(new Uint8Array(MAX_JSON_BYTES + 1));
          }
        },
        cancel: nativeCancel,
      },
      { highWaterMark: 0 },
    );
    const [consumer, capture] = stream.tee();
    const release = vi.fn(async () => {
      await capture.cancel();
      await releaseGate;
    });
    const controller = new AbortController();
    vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementationOnce(async () => {
      if (trigger === "abort-at-headers") {
        controller.abort("synthetic-private-abort");
      }
      return {
        response: new Response(consumer, { status, headers: { "content-length": "1" } }),
        finalUrl: "https://api.typesafe.ai/v1/systemone",
        release,
        refreshTimeout: () => {},
      };
    });
    let settled = false;
    const outcome = requestEvaluation({ ...request, signal: controller.signal }).then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await setImmediate();
      if (trigger === "abort") {
        controller.abort("synthetic-private-abort");
      }
      await setImmediate();
      expect(release).toHaveBeenCalledOnce();
      expect(nativeCancel).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      finishCancellation();
      await setImmediate();
      expect(settled).toBe(false);
      finishRelease();
      expect(await outcome).toMatchObject({ name: "EvaluationError", reason });
      if (trigger === "overflow") {
        expect(await outcome).toHaveProperty("message", "TypeSafe response exceeds its limit.");
      } else if (trigger.startsWith("abort")) {
        expect(await outcome).toHaveProperty("message", "TypeSafe evaluation cancelled.");
      }
      expect(release).toHaveBeenCalledOnce();
    } finally {
      // Also release the fixture after an assertion fails against the old sequential implementation.
      const cancellation = Promise.allSettled([consumer.cancel(), capture.cancel()]);
      finishCancellation();
      finishRelease();
      await cancellation;
      await outcome;
    }
  },
);

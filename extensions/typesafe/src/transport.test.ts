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

it.each([301, 302, 303, 307, 308])("never follows HTTP %s redirects", async (status) => {
  const fetch = mockFetch(
    async () =>
      new Response(null, {
        status,
        headers: { location: "https://other.example/credential-sink" },
      }),
  );
  await expect(requestEvaluation(request)).rejects.toMatchObject({ reason: "transport" });
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[0]).toBe("https://api.typesafe.ai/v1/systemone");
});
it("bounds response bodies without trusting content-length", async () => {
  mockFetch(
    async () =>
      new Response("x".repeat(MAX_JSON_BYTES + 1), { headers: { "content-length": "1" } }),
  );
  await expect(requestEvaluation(request)).rejects.toThrow("response exceeds");
});
it("bounds the serialized request including its model field", async () => {
  const fetch = mockFetch(async () => new Response());
  await expect(
    requestEvaluation({ ...request, body: { ...request.body, state: "x".repeat(MAX_JSON_BYTES) } }),
  ).rejects.toThrow("request exceeds");
  expect(fetch).not.toHaveBeenCalled();
});
it("joins cancellation of a stalled response body", async () => {
  const controller = new AbortController();
  let reading!: () => void;
  const started = new Promise<void>((resolve) => {
    reading = resolve;
  });
  let finishCleanup!: () => void;
  const cancelled = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishCleanup = resolve;
      }),
  );
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        reading();
      },
      cancel: cancelled,
    },
    { highWaterMark: 0 },
  );
  mockFetch(async () => new Response(body));
  const pending = requestEvaluation({ ...request, signal: controller.signal });
  await started;
  controller.abort(new Error("synthetic-private-abort"));
  let completed = false;
  const completion = pending.finally(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  expect(cancelled).toHaveBeenCalledOnce();
  finishCleanup();
  await expect(completion).rejects.toThrow("TypeSafe evaluation cancelled.");
  expect(cancelled).toHaveBeenCalledOnce();
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
it.each([
  { headers: new Headers({ "retry-after-ms": "250", "retry-after": "10" }), retryAfterMs: 250 },
  {
    headers: new Headers({ "retry-after-ms": "invalid", "retry-after": "10" }),
    retryAfterMs: 10000,
  },
  { headers: new Headers({ "retry-after": "invalid" }), retryAfterMs: undefined },
])("preserves rate-limit metadata without retries", async ({ headers, retryAfterMs }) => {
  const fetch = mockFetch(
    async () => new Response("synthetic private error", { status: 429, headers }),
  );
  await expect(requestEvaluation(request)).rejects.toMatchObject({
    reason: "rate-limited",
    retryAfterMs,
  });
  expect(fetch).toHaveBeenCalledOnce();
});
it.each([413, 422])(
  "cancels HTTP %s without reading secret-reflecting error bodies",
  async (status) => {
    const pull = vi.fn(() => {
      throw new Error("synthetic credential and submitted state");
    });
    const cancel = vi.fn();
    const fetch = mockFetch(
      async () =>
        new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), { status }),
    );
    const error = await requestEvaluation(request).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "EvaluationError",
      reason: "unsupported-input",
      message: "TypeSafe rejected the supplied input.",
    });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain("synthetic credential");
  },
);

it("does not expose or consume HTTP error diagnostics", async () => {
  const cancelled = vi.fn();
  mockFetch(async () => new Response(new ReadableStream({ cancel: cancelled }), { status: 401 }));
  await expect(requestEvaluation(request)).rejects.toMatchObject({ reason: "authentication" });
  expect(cancelled).toHaveBeenCalledOnce();
});

it.each([
  { status: 401, trigger: "http", reason: "authentication" },
  { status: 429, trigger: "http", reason: "rate-limited" },
  { status: 413, trigger: "http", reason: "unsupported-input" },
  { status: 422, trigger: "http", reason: "unsupported-input" },
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
        response: new Response(consumer, { status }),
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

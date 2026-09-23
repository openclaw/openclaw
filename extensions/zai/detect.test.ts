// Zai tests cover detect plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectZaiEndpoint } from "./detect.js";

type FetchResponse = { status: number; body?: unknown };

const ZAI_DETECT_ERROR_BODY_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Builds a streaming error Response whose body is far larger than the 16 MiB cap.
 * Tracks how many bytes were actually pulled and whether the consumer cancelled
 * the stream, so tests can prove the read is bounded (fail-closed) rather than
 * draining the whole untrusted body into memory.
 */
function makeOversizedStreamFetch(params: {
  url: string;
  status: number;
  chunkBytes?: number;
  hardCeilingBytes?: number;
}) {
  const chunkBytes = params.chunkBytes ?? 1024 * 1024;
  const hardCeilingBytes = params.hardCeilingBytes ?? 64 * 1024 * 1024;
  const state = { enqueuedBytes: 0, cancelled: false };

  const fetchFn = (async (url: string) => {
    if (url !== params.url) {
      throw new Error(`unexpected url: ${url}`);
    }
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (state.enqueuedBytes >= hardCeilingBytes) {
          // Safety stop: with an unbounded reader this point would be reached
          // (and the test would fail on the bounded-bytes assertion below).
          controller.close();
          return;
        }
        state.enqueuedBytes += chunkBytes;
        controller.enqueue(new Uint8Array(chunkBytes));
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return new Response(body, {
      status: params.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return { fetchFn, state };
}

/**
 * Builds a fetch returning a single raw (possibly non-JSON) error body, keyed by
 * `${url}::${model}`. Used to drive the new bounded decode path with small,
 * well-formed, empty, and malformed sub-cap bodies that must behave exactly as
 * the previous `res.json()` path did.
 */
function makeRawBodyFetch(map: Record<string, { status: number; raw: string }>) {
  return (async (url: string, init?: RequestInit) => {
    const rawBody = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const entry = map[`${url}::${rawBody?.model ?? ""}`] ?? map[url];
    if (!entry) {
      throw new Error(`unexpected url: ${url} model=${String(rawBody?.model ?? "")}`);
    }
    return new Response(entry.raw, {
      status: entry.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

/**
 * Builds a fetch returning a single raw byte body, keyed by `${url}::${model}`.
 * Unlike {@link makeRawBodyFetch} this takes bytes, so it can express a body
 * that is not valid UTF-8 at all. `calls` records the probed model ids so tests
 * can assert how far the probe advanced.
 */
function makeRawBytesFetch(
  map: Record<string, { status: number; bytes: Uint8Array }>,
  calls?: string[],
) {
  return (async (url: string, init?: RequestInit) => {
    const rawBody = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls?.push(String(rawBody?.model ?? ""));
    const entry = map[`${url}::${rawBody?.model ?? ""}`] ?? map[url];
    if (!entry) {
      throw new Error(`unexpected url: ${url} model=${String(rawBody?.model ?? "")}`);
    }
    // Copy into a fresh ArrayBuffer-backed view: BodyInit rejects the
    // ArrayBufferLike-backed Uint8Array that Buffer/TextEncoder can produce.
    const body = new Uint8Array(new ArrayBuffer(entry.bytes.byteLength));
    body.set(entry.bytes);
    return new Response(body, {
      status: entry.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function makeFetch(map: Record<string, FetchResponse>) {
  return (async (url: string, init?: RequestInit) => {
    const rawBody = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const entry = map[`${url}::${rawBody?.model ?? ""}`] ?? map[url];
    if (!entry) {
      throw new Error(`unexpected url: ${url} model=${String(rawBody?.model ?? "")}`);
    }
    const json = entry.body ?? {};
    return new Response(JSON.stringify(json), {
      status: entry.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("detectZaiEndpoint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves preferred/fallback endpoints and null when probes fail", async () => {
    const scenarios: Array<{
      endpoint?: "global" | "cn" | "coding-global" | "coding-cn";
      responses: Record<string, { status: number; body?: unknown }>;
      expected: { endpoint: string; modelId: string } | null;
    }> = [
      {
        responses: {
          "https://api.z.ai/api/paas/v4/chat/completions::glm-5.2": { status: 200 },
        },
        expected: { endpoint: "global", modelId: "glm-5.2" },
      },
      {
        responses: {
          "https://api.z.ai/api/paas/v4/chat/completions::glm-5.2": { status: 404 },
          "https://open.bigmodel.cn/api/paas/v4/chat/completions::glm-5.2": { status: 200 },
        },
        expected: { endpoint: "cn", modelId: "glm-5.2" },
      },
      {
        responses: {
          "https://api.z.ai/api/paas/v4/chat/completions::glm-5.2": { status: 404 },
          "https://open.bigmodel.cn/api/paas/v4/chat/completions::glm-5.2": { status: 404 },
          "https://api.z.ai/api/coding/paas/v4/chat/completions::glm-5.3": { status: 200 },
        },
        expected: { endpoint: "coding-global", modelId: "glm-5.3" },
      },
      {
        endpoint: "coding-global",
        responses: {
          "https://api.z.ai/api/coding/paas/v4/chat/completions::glm-5.3": {
            status: 400,
            body: { code: 1311, msg: "model not included in the current plan" },
          },
          "https://api.z.ai/api/coding/paas/v4/chat/completions::glm-5.1": {
            status: 400,
            body: { code: 1211, msg: "model does not exist" },
          },
          "https://api.z.ai/api/coding/paas/v4/chat/completions::glm-4.7": { status: 200 },
        },
        expected: { endpoint: "coding-global", modelId: "glm-4.7" },
      },
      {
        endpoint: "coding-global",
        responses: {
          "https://api.z.ai/api/coding/paas/v4/chat/completions::glm-5.3": {
            status: 429,
            body: { error: { message: "rate limited" } },
          },
        },
        expected: null,
      },
      {
        endpoint: "coding-cn",
        responses: {
          "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions::glm-5.3": {
            status: 200,
          },
        },
        expected: { endpoint: "coding-cn", modelId: "glm-5.3" },
      },
      {
        endpoint: "coding-cn",
        responses: {
          "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions::glm-5.3": {
            status: 404,
          },
          "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions::glm-5.1": {
            status: 200,
          },
        },
        expected: { endpoint: "coding-cn", modelId: "glm-5.1" },
      },
      {
        endpoint: "coding-cn",
        responses: {
          "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions::glm-5.3": {
            status: 404,
            body: { error: { message: "glm-5.3 unavailable" } },
          },
          "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions::glm-5.1": {
            status: 404,
            body: { error: { message: "glm-5.1 unavailable" } },
          },
          "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions::glm-4.7": {
            status: 200,
          },
        },
        expected: { endpoint: "coding-cn", modelId: "glm-4.7" },
      },
      {
        responses: {
          "https://api.z.ai/api/paas/v4/chat/completions::glm-5.2": { status: 401 },
          "https://open.bigmodel.cn/api/paas/v4/chat/completions::glm-5.2": { status: 401 },
          "https://api.z.ai/api/coding/paas/v4/chat/completions::glm-5.3": { status: 401 },
          "https://api.z.ai/api/coding/paas/v4/chat/completions::glm-5.1": { status: 401 },
          "https://api.z.ai/api/coding/paas/v4/chat/completions::glm-4.7": { status: 401 },
          "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions::glm-5.3": {
            status: 401,
          },
          "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions::glm-5.1": {
            status: 401,
          },
          "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions::glm-4.7": {
            status: 401,
          },
        },
        expected: null,
      },
    ];

    for (const scenario of scenarios) {
      const detected = await detectZaiEndpoint({
        apiKey: "sk-test", // pragma: allowlist secret
        ...(scenario.endpoint ? { endpoint: scenario.endpoint } : {}),
        fetchFn: makeFetch(scenario.responses),
      });

      if (scenario.expected === null) {
        expect(detected).toBeNull();
      } else {
        expect(detected?.endpoint).toBe(scenario.expected.endpoint);
        expect(detected?.modelId).toBe(scenario.expected.modelId);
      }
    }
  });

  it("caps oversized probe timeouts before scheduling", async () => {
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
    const fetchFn = makeFetch({
      "https://api.z.ai/api/paas/v4/chat/completions::glm-5.2": { status: 200 },
    });

    await detectZaiEndpoint({
      apiKey: "sk-test", // pragma: allowlist secret
      fetchFn,
      timeoutMs: MAX_TIMER_TIMEOUT_MS + 1_000_000,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("still parses well-formed sub-cap error bodies to drive endpoint classification", async () => {
    // Happy path: model-not-found errors must still be decoded from the bounded
    // body so the probe classifies them as unsupported and walks to the GLM-4.7
    // fallback. The error message that drives classification lives only inside
    // the body, so a passing fallback proves the new bounded reader decoded it.
    const codingGlobal = "https://api.z.ai/api/coding/paas/v4/chat/completions";
    const detected = await detectZaiEndpoint({
      apiKey: "sk-test", // pragma: allowlist secret
      endpoint: "coding-global",
      fetchFn: makeRawBodyFetch({
        [`${codingGlobal}::glm-5.3`]: {
          status: 400,
          raw: JSON.stringify({ error: { message: "model not found for this plan" } }),
        },
        [`${codingGlobal}::glm-5.1`]: {
          status: 400,
          raw: JSON.stringify({ code: 1211, msg: "model does not exist" }),
        },
        [`${codingGlobal}::glm-4.7`]: { status: 200, raw: "{}" },
      }),
    });

    expect(detected?.endpoint).toBe("coding-global");
    expect(detected?.modelId).toBe("glm-4.7");
  });

  it("swallows malformed and empty sub-cap error bodies and falls back on status", async () => {
    // Regression: a non-JSON or empty error body must not throw out of the
    // probe. JSON.parse fails, the existing try/catch swallows it, and the
    // probe degrades to status-only classification (404 => unsupported model),
    // so the GLM-4.7 fallback still resolves exactly as before.
    const codingGlobal = "https://api.z.ai/api/coding/paas/v4/chat/completions";
    const detected = await detectZaiEndpoint({
      apiKey: "sk-test", // pragma: allowlist secret
      endpoint: "coding-global",
      fetchFn: makeRawBodyFetch({
        [`${codingGlobal}::glm-5.3`]: { status: 404, raw: "<html>gateway error</html>" },
        [`${codingGlobal}::glm-5.1`]: { status: 404, raw: "" },
        [`${codingGlobal}::glm-4.7`]: { status: 200, raw: "{}" },
      }),
    });

    expect(detected?.endpoint).toBe("coding-global");
    expect(detected?.modelId).toBe("glm-4.7");
  });

  it("rejects sub-cap error bodies that are not valid UTF-8 instead of classifying substituted text", async () => {
    // Regression: a non-fatal TextDecoder replaced malformed bytes with U+FFFD,
    // so JSON.parse succeeded on a body that was never valid UTF-8 and the
    // substituted text was consumed as a genuine error code. A corrupt body must
    // now be swallowed by the same try/catch as a non-JSON body, so the probe
    // can no longer treat fabricated text as an "unsupported model" signal.
    const codingGlobal = "https://api.z.ai/api/coding/paas/v4/chat/completions";
    // `{"code":1211,...}` with one continuation byte of a multibyte char replaced,
    // so the body is invalid UTF-8 but becomes parseable once substituted.
    const malformed = new TextEncoder().encode('{"code":1211,"msg":"x\u{1F99E}"}');
    const corrupt = new Uint8Array(malformed);
    const lobsterStart = corrupt.indexOf(0xf0);
    expect(lobsterStart).toBeGreaterThan(-1);
    corrupt[lobsterStart + 1] = 0x28;
    // Prove the fixture really is rejected by a fatal decode. (Bare TextDecoder is
    // the pre-fix behavior under test, so it is asserted via its substitution.)
    expect(new TextDecoder().decode(corrupt)).toContain("\uFFFD");

    const calls: string[] = [];
    const detected = await detectZaiEndpoint({
      apiKey: "sk-test", // pragma: allowlist secret
      endpoint: "coding-global",
      fetchFn: makeRawBytesFetch(
        {
          // Status 400 with a corrupt body: the code inside is NOT trustworthy, so
          // it must not advance the probe to the next candidate model.
          [`${codingGlobal}::glm-5.3`]: { status: 400, bytes: corrupt },
          [`${codingGlobal}::glm-5.1`]: { status: 400, bytes: corrupt },
          [`${codingGlobal}::glm-4.7`]: { status: 200, bytes: new TextEncoder().encode("{}") },
        },
        calls,
      ),
    });

    // The corrupt body classifies nothing, so the probe stops at the first
    // candidate instead of walking on to the GLM-4.7 fallback.
    expect(calls).toEqual(["glm-5.3"]);
    expect(detected).toBeNull();
  });

  it("still classifies well-formed multibyte error bodies (fatal decode does not regress valid UTF-8)", async () => {
    // Guard for the fix above: valid multibyte content must keep decoding, so the
    // fatal decoder cannot be rejecting legitimate non-ASCII bodies. A 400 whose
    // message says the model does not exist must still advance to the fallback.
    const codingGlobal = "https://api.z.ai/api/coding/paas/v4/chat/completions";
    const valid = new TextEncoder().encode(
      '{"error":{"code":1211,"message":"model \u4e0d\u5b58\u5728 \u{1F99E}"}}',
    );

    const detected = await detectZaiEndpoint({
      apiKey: "sk-test", // pragma: allowlist secret
      endpoint: "coding-global",
      fetchFn: makeRawBytesFetch({
        [`${codingGlobal}::glm-5.3`]: { status: 400, bytes: valid },
        [`${codingGlobal}::glm-5.1`]: { status: 400, bytes: valid },
        [`${codingGlobal}::glm-4.7`]: { status: 200, bytes: new TextEncoder().encode("{}") },
      }),
    });

    expect(detected?.endpoint).toBe("coding-global");
    expect(detected?.modelId).toBe("glm-4.7");
  });

  it("fails closed on oversized probe error bodies without buffering unbounded", async () => {
    const { fetchFn, state } = makeOversizedStreamFetch({
      url: "https://api.z.ai/api/paas/v4/chat/completions",
      status: 400,
    });

    const detected = await detectZaiEndpoint({
      apiKey: "sk-test", // pragma: allowlist secret
      endpoint: "global",
      fetchFn,
    });

    // Probe swallows the bounded-read overflow and falls back to status-only,
    // so the oversized error body cannot promote this endpoint.
    expect(detected).toBeNull();
    // The stream was cancelled (fail-closed) instead of being drained to the
    // 64 MiB safety ceiling, proving the read stops near the 16 MiB cap.
    expect(state.cancelled).toBe(true);
    expect(state.enqueuedBytes).toBeLessThanOrEqual(
      ZAI_DETECT_ERROR_BODY_MAX_BYTES + 2 * 1024 * 1024,
    );
  });

  it.each([
    { bodyDelayMs: 31_000, expectedModel: "glm-5.1", expectedCalls: 2 },
    { bodyDelayMs: 41_000, expectedModel: undefined, expectedCalls: 1 },
  ])("honors a 40s probe deadline with a $bodyDelayMs ms error body", async (scenario) => {
    vi.useFakeTimers();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let calls = 0;
    try {
      const detectedPromise = detectZaiEndpoint({
        apiKey: "sk-test", // pragma: allowlist secret
        endpoint: "coding-global",
        timeoutMs: 40_000,
        fetchFn: async () => {
          calls += 1;
          if (calls > 1) {
            return new Response("{}", { status: 200 });
          }
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                timer = setTimeout(() => {
                  controller.enqueue(new TextEncoder().encode('{"error":{"code":"1211"}}'));
                  controller.close();
                }, scenario.bodyDelayMs);
              },
              cancel() {
                clearTimeout(timer);
              },
            }),
            { status: 400 },
          );
        },
      });

      await vi.advanceTimersByTimeAsync(41_001);
      expect((await detectedPromise)?.modelId).toBe(scenario.expectedModel);
      expect(calls).toBe(scenario.expectedCalls);
    } finally {
      clearTimeout(timer);
      vi.useRealTimers();
    }
  });

  it("fails closed when a probe error body stalls without chunks", async () => {
    // Headers return 400, but the error body never enqueues. Without
    // the whole-body deadline the probe would hang indefinitely.
    const fetchFn = (async (url: string) => {
      if (url !== "https://api.z.ai/api/paas/v4/chat/completions") {
        throw new Error(`unexpected url: ${url}`);
      }
      const body = new ReadableStream<Uint8Array>({
        start() {
          // Intentionally never enqueue or close — idle timeout must fire.
        },
      });
      return new Response(body, {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const timeoutMs = 80;
    const startedAt = Date.now();
    const detected = await detectZaiEndpoint({
      apiKey: "sk-test", // pragma: allowlist secret
      endpoint: "global",
      timeoutMs,
      fetchFn,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(detected).toBeNull();
    // The probe must fail within the deadline budget, not hang indefinitely.
    // Allow 2× the timeout for scheduling overhead; a hang would take seconds.
    expect(elapsedMs).toBeLessThan(2 * timeoutMs);
  });

  it("keeps one probe deadline through a slow-drip error body", async () => {
    const state = { cancelled: false };
    let interval: ReturnType<typeof setInterval> | undefined;
    const fetchFn = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          interval = setInterval(() => controller.enqueue(new Uint8Array([123])), 10);
        },
        cancel() {
          state.cancelled = true;
          if (interval) {
            clearInterval(interval);
          }
        },
      });
      return new Response(body, {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const timeoutMs = 80;
    const startedAt = Date.now();
    const detected = await detectZaiEndpoint({
      apiKey: "sk-test", // pragma: allowlist secret
      endpoint: "global",
      timeoutMs,
      fetchFn,
    });

    expect(detected).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(3 * timeoutMs);
    expect(state.cancelled).toBe(true);
  });
});

import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectZaiEndpoint, type ZaiEndpointId } from "./detect.js";

type FetchResponse = {
  status: number;
  body?: unknown;
  raw?: string;
  bytes?: Uint8Array;
};

const ZAI_DETECT_ERROR_BODY_MAX_BYTES = 16 * 1024 * 1024;

function makeOversizedStreamFetch() {
  const chunkBytes = 1024 * 1024;
  const hardCeilingBytes = 64 * 1024 * 1024;
  const state = { enqueuedBytes: 0, cancelled: false };

  const fetchFn = (async (url: string) => {
    if (url !== "https://api.z.ai/api/paas/v4/chat/completions") {
      throw new Error(`unexpected url: ${url}`);
    }
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Bound the fixture even if the production reader stops enforcing its cap.
        if (state.enqueuedBytes >= hardCeilingBytes) {
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
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return { fetchFn, state };
}

function makeFetch(map: Record<string, FetchResponse>, calls?: string[]) {
  return (async (url: string, init?: RequestInit) => {
    const rawBody = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls?.push(String(rawBody?.model ?? ""));
    const entry = map[`${url}::${rawBody?.model ?? ""}`] ?? map[url];
    if (!entry) {
      throw new Error(`unexpected url: ${url} model=${String(rawBody?.model ?? "")}`);
    }
    // Copy byte fixtures into an ArrayBuffer-backed view accepted by BodyInit.
    const body = entry.bytes
      ? new Uint8Array(entry.bytes)
      : (entry.raw ?? JSON.stringify(entry.body ?? {}));
    return new Response(body, {
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
    const urls = {
      global: "https://api.z.ai/api/paas/v4/chat/completions",
      cn: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      "coding-global": "https://api.z.ai/api/coding/paas/v4/chat/completions",
      "coding-cn": "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
    };
    const scenarios: Array<{
      endpoint?: ZaiEndpointId;
      responses: Array<[ZaiEndpointId, string, number, unknown?]>;
      expected: { endpoint: string; modelId: string } | null;
    }> = [
      {
        responses: [["global", "glm-5.2", 200]],
        expected: { endpoint: "global", modelId: "glm-5.2" },
      },
      {
        responses: [
          ["global", "glm-5.2", 404],
          ["cn", "glm-5.2", 200],
        ],
        expected: { endpoint: "cn", modelId: "glm-5.2" },
      },
      {
        responses: [
          ["global", "glm-5.2", 404],
          ["cn", "glm-5.2", 404],
          ["coding-global", "glm-5.3", 200],
        ],
        expected: { endpoint: "coding-global", modelId: "glm-5.3" },
      },
      {
        endpoint: "coding-global",
        responses: [
          [
            "coding-global",
            "glm-5.3",
            400,
            { code: 1311, msg: "model not included in the current plan" },
          ],
          ["coding-global", "glm-5.1", 400, { code: 1211, msg: "model does not exist" }],
          ["coding-global", "glm-4.7", 200],
        ],
        expected: { endpoint: "coding-global", modelId: "glm-4.7" },
      },
      {
        endpoint: "coding-global",
        responses: [["coding-global", "glm-5.3", 429, { error: { message: "rate limited" } }]],
        expected: null,
      },
      {
        endpoint: "coding-cn",
        responses: [["coding-cn", "glm-5.3", 200]],
        expected: { endpoint: "coding-cn", modelId: "glm-5.3" },
      },
      {
        endpoint: "coding-cn",
        responses: [
          ["coding-cn", "glm-5.3", 404],
          ["coding-cn", "glm-5.1", 200],
        ],
        expected: { endpoint: "coding-cn", modelId: "glm-5.1" },
      },
      {
        endpoint: "coding-cn",
        responses: [
          ["coding-cn", "glm-5.3", 404, { error: { message: "glm-5.3 unavailable" } }],
          ["coding-cn", "glm-5.1", 404, { error: { message: "glm-5.1 unavailable" } }],
          ["coding-cn", "glm-4.7", 200],
        ],
        expected: { endpoint: "coding-cn", modelId: "glm-4.7" },
      },
      {
        responses: [
          ["global", "glm-5.2", 401],
          ["cn", "glm-5.2", 401],
          ["coding-global", "glm-5.3", 401],
          ["coding-global", "glm-5.1", 401],
          ["coding-global", "glm-4.7", 401],
          ["coding-cn", "glm-5.3", 401],
          ["coding-cn", "glm-5.1", 401],
          ["coding-cn", "glm-4.7", 401],
        ],
        expected: null,
      },
    ];

    for (const scenario of scenarios) {
      const detected = await detectZaiEndpoint({
        apiKey: "sk-test", // pragma: allowlist secret
        ...(scenario.endpoint ? { endpoint: scenario.endpoint } : {}),
        fetchFn: makeFetch(
          Object.fromEntries(
            scenario.responses.map(([endpoint, model, status, body]) => [
              `${urls[endpoint]}::${model}`,
              { status, body },
            ]),
          ),
        ),
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
    const codingGlobal = "https://api.z.ai/api/coding/paas/v4/chat/completions";
    const detected = await detectZaiEndpoint({
      apiKey: "sk-test", // pragma: allowlist secret
      endpoint: "coding-global",
      fetchFn: makeFetch({
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
    const codingGlobal = "https://api.z.ai/api/coding/paas/v4/chat/completions";
    const detected = await detectZaiEndpoint({
      apiKey: "sk-test", // pragma: allowlist secret
      endpoint: "coding-global",
      fetchFn: makeFetch({
        [`${codingGlobal}::glm-5.3`]: { status: 404, raw: "<html>gateway error</html>" },
        [`${codingGlobal}::glm-5.1`]: { status: 404, raw: "" },
        [`${codingGlobal}::glm-4.7`]: { status: 200, raw: "{}" },
      }),
    });

    expect(detected?.endpoint).toBe("coding-global");
    expect(detected?.modelId).toBe("glm-4.7");
  });

  it("rejects sub-cap error bodies that are not valid UTF-8 instead of classifying substituted text", async () => {
    const codingGlobal = "https://api.z.ai/api/coding/paas/v4/chat/completions";
    // Invalid UTF-8 must not turn into a trusted error code via replacement characters.
    const malformed = new TextEncoder().encode('{"code":1211,"msg":"x\u{1F99E}"}');
    const corrupt = new Uint8Array(malformed);
    const lobsterStart = corrupt.indexOf(0xf0);
    expect(lobsterStart).toBeGreaterThan(-1);
    corrupt[lobsterStart + 1] = 0x28;
    expect(new TextDecoder().decode(corrupt)).toContain("\uFFFD");

    const calls: string[] = [];
    const detected = await detectZaiEndpoint({
      apiKey: "sk-test", // pragma: allowlist secret
      endpoint: "coding-global",
      fetchFn: makeFetch(
        {
          [`${codingGlobal}::glm-5.3`]: { status: 400, bytes: corrupt },
          [`${codingGlobal}::glm-5.1`]: { status: 400, bytes: corrupt },
          [`${codingGlobal}::glm-4.7`]: { status: 200, bytes: new TextEncoder().encode("{}") },
        },
        calls,
      ),
    });

    expect(calls).toEqual(["glm-5.3"]);
    expect(detected).toBeNull();
  });

  it("still classifies well-formed multibyte error bodies (fatal decode does not regress valid UTF-8)", async () => {
    const codingGlobal = "https://api.z.ai/api/coding/paas/v4/chat/completions";
    const valid = new TextEncoder().encode(
      '{"error":{"code":1211,"message":"model \u4e0d\u5b58\u5728 \u{1F99E}"}}',
    );

    const detected = await detectZaiEndpoint({
      apiKey: "sk-test", // pragma: allowlist secret
      endpoint: "coding-global",
      fetchFn: makeFetch({
        [`${codingGlobal}::glm-5.3`]: { status: 400, bytes: valid },
        [`${codingGlobal}::glm-5.1`]: { status: 400, bytes: valid },
        [`${codingGlobal}::glm-4.7`]: { status: 200, bytes: new TextEncoder().encode("{}") },
      }),
    });

    expect(detected?.endpoint).toBe("coding-global");
    expect(detected?.modelId).toBe("glm-4.7");
  });

  it("fails closed on oversized probe error bodies without buffering unbounded", async () => {
    const { fetchFn, state } = makeOversizedStreamFetch();

    const detected = await detectZaiEndpoint({
      apiKey: "sk-test", // pragma: allowlist secret
      endpoint: "global",
      fetchFn,
    });

    expect(detected).toBeNull();
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
    const fetchFn = (async (url: string) => {
      if (url !== "https://api.z.ai/api/paas/v4/chat/completions") {
        throw new Error(`unexpected url: ${url}`);
      }
      // Headers arrived, but the body never produces a chunk or closes.
      const body = new ReadableStream<Uint8Array>();
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

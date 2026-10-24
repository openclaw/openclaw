import { oversizedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectZaiEndpoint, type ZaiEndpointId } from "./detect.js";

type FetchResponse = {
  status: number;
  body?: unknown;
  bytes?: Uint8Array;
};

const ZAI_DETECT_ERROR_BODY_MAX_BYTES = 16 * 1024 * 1024;
const urls = {
  global: "https://api.z.ai/api/paas/v4/chat/completions",
  cn: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  "coding-global": "https://api.z.ai/api/coding/paas/v4/chat/completions",
  "coding-cn": "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
};
const detect = (params: Omit<Parameters<typeof detectZaiEndpoint>[0], "apiKey">) =>
  detectZaiEndpoint({ apiKey: "sk-test", ...params }); // pragma: allowlist secret

async function expectBodyDeadline(
  body: UnderlyingDefaultSource<Uint8Array>,
  chunks?: () => number,
) {
  const state = { cancelled: false, settled: false };
  const result = detect({
    endpoint: "global",
    timeoutMs: 80,
    fetchFn: async (url) => {
      expect(url).toBe(urls.global);
      return new Response(
        new ReadableStream({
          ...body,
          cancel(reason) {
            state.cancelled = true;
            return body.cancel?.(reason);
          },
        }),
        { status: 400 },
      );
    },
  }).then((value) => {
    state.settled = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(79);
  expect(state).toEqual({ cancelled: false, settled: false });
  if (chunks) {
    expect(chunks()).toBe(7);
  }
  await vi.advanceTimersByTimeAsync(1);
  expect(state).toEqual({ cancelled: true, settled: true });
  expect(await result).toBeNull();
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
    const body = entry.bytes ? new Uint8Array(entry.bytes) : JSON.stringify(entry.body ?? {});
    return new Response(body, {
      status: entry.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("detectZaiEndpoint", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves preferred/fallback endpoints and null when probes fail", async () => {
    type Reply = [ZaiEndpointId, string, number, unknown?];
    async function check(
      endpoint: ZaiEndpointId | undefined,
      expected: [ZaiEndpointId, string] | null,
      ...responses: Reply[]
    ) {
      const detected = await detect({
        endpoint,
        fetchFn: makeFetch(
          Object.fromEntries(
            responses.map(([replyEndpoint, model, status, body]) => [
              `${urls[replyEndpoint]}::${model}`,
              { status, body },
            ]),
          ),
        ),
      });

      if (expected === null) {
        expect(detected).toBeNull();
      } else {
        expect(detected).toMatchObject({ endpoint: expected[0], modelId: expected[1] });
      }
    }
    await check(undefined, ["global", "glm-5.2"], ["global", "glm-5.2", 200]);
    await check(undefined, ["cn", "glm-5.2"], ["global", "glm-5.2", 404], ["cn", "glm-5.2", 200]);
    await check(
      undefined,
      ["coding-global", "glm-5.3"],
      ["global", "glm-5.2", 404],
      ["cn", "glm-5.2", 404],
      ["coding-global", "glm-5.3", 200],
    );
    await check(
      "coding-global",
      ["coding-global", "glm-4.7"],
      [
        "coding-global",
        "glm-5.3",
        400,
        { code: 1311, msg: "model not included in the current plan" },
      ],
      ["coding-global", "glm-5.1", 400, { code: 1211, msg: "model does not exist" }],
      ["coding-global", "glm-4.7", 200],
    );
    await check("coding-global", null, [
      "coding-global",
      "glm-5.3",
      429,
      { error: { message: "rate limited" } },
    ]);
    await check(
      "coding-cn",
      ["coding-cn", "glm-5.1"],
      ["coding-cn", "glm-5.3", 404],
      ["coding-cn", "glm-5.1", 200],
    );
    await check(
      "coding-cn",
      ["coding-cn", "glm-4.7"],
      ["coding-cn", "glm-5.3", 404, { error: { message: "glm-5.3 unavailable" } }],
      ["coding-cn", "glm-5.1", 404, { error: { message: "glm-5.1 unavailable" } }],
      ["coding-cn", "glm-4.7", 200],
    );
    await check(
      undefined,
      null,
      ["global", "glm-5.2", 401],
      ["cn", "glm-5.2", 401],
      ["coding-global", "glm-5.3", 401],
      ["coding-cn", "glm-5.3", 401],
    );
  });

  it("rejects sub-cap error bodies that are not valid UTF-8 instead of classifying substituted text", async () => {
    const codingGlobal = "https://api.z.ai/api/coding/paas/v4/chat/completions";
    // Invalid UTF-8 must not turn into a trusted error code via replacement characters.
    const corrupt = new TextEncoder().encode('{"code":1211,"msg":"x\u{1F99E}"}');
    const lobsterStart = corrupt.indexOf(0xf0);
    expect(lobsterStart).toBeGreaterThan(-1);
    corrupt[lobsterStart + 1] = 0x28;
    expect(new TextDecoder().decode(corrupt)).toContain("\uFFFD");

    const calls: string[] = [];
    const detected = await detect({
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

  it("fails closed on oversized probe error bodies without buffering unbounded", async () => {
    const { response, state } = oversizedJsonResponse();
    const detected = await detect({
      endpoint: "global",
      fetchFn: async (url) => {
        expect(url).toBe(urls.global);
        return new Response(response.body, { status: 400, headers: response.headers });
      },
    });

    expect(detected).toBeNull();
    expect(state.canceled).toBe(true);
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
      const detectedPromise = detect({
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
    }
  });

  it("fails closed when a probe error body stalls without chunks", async () => {
    vi.useFakeTimers();
    await expectBodyDeadline({});
  });

  it("keeps one probe deadline through a slow-drip error body", async () => {
    vi.useFakeTimers();
    let chunks = 0;
    let interval: ReturnType<typeof setInterval> | undefined;
    try {
      await expectBodyDeadline(
        {
          start(controller) {
            interval = setInterval(() => {
              chunks += 1;
              controller.enqueue(new Uint8Array([123]));
            }, 10);
          },
          cancel() {
            clearInterval(interval);
          },
        },
        () => chunks,
      );
    } finally {
      clearInterval(interval);
    }
  });
});

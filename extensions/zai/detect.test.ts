import { oversizedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectZaiEndpoint, type ZaiEndpointId } from "./detect.js";

const urls = {
  global: "https://api.z.ai/api/paas/v4/chat/completions",
  cn: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  "coding-global": "https://api.z.ai/api/coding/paas/v4/chat/completions",
  "coding-cn": "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
};
const detect = (params: Omit<Parameters<typeof detectZaiEndpoint>[0], "apiKey">) =>
  detectZaiEndpoint({ apiKey: "sk-test", ...params }); // pragma: allowlist secret
const errorResponse = (body: UnderlyingDefaultSource<Uint8Array>) =>
  new Response(new ReadableStream(body), { status: 400 });

type Reply = [ZaiEndpointId, string, number, unknown?];
function makeFetch(replies: Reply[], calls?: string[]) {
  return (async (url: string, init?: RequestInit) => {
    const rawBody = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls?.push(String(rawBody?.model ?? ""));
    const entry = replies.find(
      ([endpoint, model]) => urls[endpoint] === url && model === rawBody?.model,
    );
    if (!entry) {
      throw new Error(`unexpected url: ${url} model=${String(rawBody?.model ?? "")}`);
    }
    // Copy byte fixtures into an ArrayBuffer-backed view accepted by BodyInit.
    const body =
      entry[3] instanceof Uint8Array ? new Uint8Array(entry[3]) : JSON.stringify(entry[3] ?? {});
    return new Response(body, {
      status: entry[2],
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("detectZaiEndpoint", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves preferred/fallback endpoints and null when probes fail", async () => {
    async function check(
      endpoint: ZaiEndpointId | undefined,
      expected: [ZaiEndpointId, string] | null,
      ...responses: Reply[]
    ) {
      const detected = await detect({
        endpoint,
        fetchFn: makeFetch(responses),
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
      "coding-global",
      ["coding-global", "glm-4.7"],
      ["coding-global", "glm-5.3", 400, { code: 1311 }],
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
      undefined,
      null,
      ["global", "glm-5.2", 401],
      ["cn", "glm-5.2", 401],
      ["coding-global", "glm-5.3", 401],
      ["coding-cn", "glm-5.3", 401],
    );
  });

  it("rejects sub-cap error bodies that are not valid UTF-8 instead of classifying substituted text", async () => {
    // Invalid UTF-8 must not turn into a trusted error code via replacement characters.
    const corrupt = new TextEncoder().encode('{"code":1211,"msg":"X"}');
    corrupt[corrupt.indexOf(88)] = 0xff;
    const calls: string[] = [];
    const detected = await detect({
      endpoint: "coding-global",
      fetchFn: makeFetch([["coding-global", "glm-5.3", 400, corrupt]], calls),
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
    expect(state.enqueuedBytes).toBeLessThanOrEqual(18 * 1024 * 1024);
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
          return errorResponse({
            start(controller) {
              timer = setTimeout(() => {
                controller.enqueue(new TextEncoder().encode('{"error":{"code":"1211"}}'));
                controller.close();
              }, scenario.bodyDelayMs);
            },
            cancel() {
              clearTimeout(timer);
            },
          });
        },
      });

      await vi.advanceTimersByTimeAsync(41_001);
      expect((await detectedPromise)?.modelId).toBe(scenario.expectedModel);
      expect(calls).toBe(scenario.expectedCalls);
    } finally {
      clearTimeout(timer);
    }
  });

  it.each([false, true])("keeps one body deadline (slow drip: %s)", async (drip) => {
    vi.useFakeTimers();
    let chunks = 0;
    let interval: ReturnType<typeof setInterval> | undefined;
    const state = { cancelled: false, settled: false };
    try {
      const result = detect({
        endpoint: "global",
        timeoutMs: 80,
        fetchFn: async (url) => {
          expect(url).toBe(urls.global);
          return errorResponse({
            start(controller) {
              if (drip) {
                interval = setInterval(() => {
                  chunks += 1;
                  controller.enqueue(new Uint8Array([123]));
                }, 10);
              }
            },
            cancel() {
              state.cancelled = true;
              clearInterval(interval);
            },
          });
        },
      }).then((value) => {
        state.settled = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(79);
      expect(state).toEqual({ cancelled: false, settled: false });
      expect(chunks).toBe(drip ? 7 : 0);
      await vi.advanceTimersByTimeAsync(1);
      expect(state).toEqual({ cancelled: true, settled: true });
      expect(await result).toBeNull();
    } finally {
      clearInterval(interval);
    }
  });
});

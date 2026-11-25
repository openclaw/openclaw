import { clearRuntimeAuthProfileStoreSnapshots } from "openclaw/plugin-sdk/agent-runtime";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import {
  expectDashscopeVideoTaskPoll,
  expectSuccessfulDashscopeVideoResult,
  mockSuccessfulDashscopeVideoTask,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { afterEach, assert, beforeAll, expect, it, vi } from "vitest";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();

let qwenVideoGenerationProvider: typeof import("./video-generation-provider.js").qwenVideoGenerationProvider;

beforeAll(async () => {
  ({ qwenVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  vi.unstubAllEnvs();
});

function qwenConfig(baseUrl: string) {
  return { models: { providers: { qwen: { baseUrl, models: [] } } } };
}

function generateVideo(
  overrides: Partial<Parameters<typeof qwenVideoGenerationProvider.generateVideo>[0]>,
) {
  return qwenVideoGenerationProvider.generateVideo({
    provider: "qwen",
    model: "wan2.6-t2v",
    prompt: "animate this shot",
    cfg: {},
    ...overrides,
  });
}

function expectPostJsonRequest(
  call: unknown,
  expected: { url: string; body: Record<string, unknown>; elapsedMs: number },
) {
  assert(call && typeof call === "object" && "timeoutMs" in call && "headers" in call);
  expect(call).toHaveProperty("url", expected.url);
  expect(call).toHaveProperty("body", expected.body);
  // Submission receives the remaining operation budget after preparation consumes clock ticks.
  expect(call.timeoutMs).toBeGreaterThan(0);
  expect(call.timeoutMs).toBeLessThanOrEqual(120_000);
  expect(call.timeoutMs).toBeGreaterThanOrEqual(120_000 - expected.elapsedMs);
  expect(call).toMatchObject({ fetchFn: globalThis.fetch, allowPrivateNetwork: false });
  expect(Reflect.get(call, "dispatcherPolicy")).toBeUndefined();
  assert(call.headers instanceof Headers);
  expect(Array.from(call.headers.entries())).toEqual([
    ["authorization", "Bearer provider-key"],
    ["content-type", "application/json"],
    ["x-dashscope-async", "enable"],
  ]);
}

it("submits async Wan generation, polls task status, and downloads the resulting video", async () => {
  mockSuccessfulDashscopeVideoTask({ postJsonRequestMock, fetchWithTimeoutMock });
  let nowMs = performance.now();
  // Preparation consumes the same monotonic clock used by the operation budget.
  const clock = vi.spyOn(performance, "now").mockImplementation(() => nowMs++);
  try {
    const startedAt = performance.now();
    const result = await generateVideo({
      model: "wan2.6-r2v-flash",
      inputImages: [{ url: "https://example.com/ref.png" }],
      durationSeconds: 6,
      audio: true,
    });

    expect(postJsonRequestMock).toHaveBeenCalledTimes(1);
    expectPostJsonRequest(postJsonRequestMock.mock.calls[0]?.[0], {
      elapsedMs: performance.now() - startedAt,
      url: "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
      body: {
        model: "wan2.6-r2v-flash",
        input: {
          prompt: "animate this shot",
          reference_urls: ["https://example.com/ref.png"],
        },
        parameters: { duration: 6, audio: true },
      },
    });
    expectDashscopeVideoTaskPoll(fetchWithTimeoutMock);
    expectSuccessfulDashscopeVideoResult(result);
  } finally {
    clock.mockRestore();
  }
});

it("routes a custom Standard endpoint to its own AIGC host", async () => {
  const aigcBaseUrl = "https://proxy.example.test/vendor-prefix";
  mockSuccessfulDashscopeVideoTask({ postJsonRequestMock, fetchWithTimeoutMock });

  await generateVideo({ cfg: qwenConfig(`${aigcBaseUrl}/`) });

  expect(postJsonRequestMock.mock.calls[0]?.[0]).toMatchObject({
    url: `${aigcBaseUrl}/api/v1/services/aigc/video-generation/video-synthesis`,
  });
  expectDashscopeVideoTaskPoll(fetchWithTimeoutMock, { baseUrl: aigcBaseUrl });
});

it("rejects Wan generation through a subscription endpoint", async () => {
  await expect(
    generateVideo({
      cfg: qwenConfig("https://coding-intl.dashscope.aliyuncs.com/v1"),
    }),
  ).rejects.toThrow(/Standard DashScope endpoint.*same-region Standard API key/i);

  expect(postJsonRequestMock).not.toHaveBeenCalled();
});

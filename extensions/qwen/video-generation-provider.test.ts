import { clearRuntimeAuthProfileStoreSnapshots } from "openclaw/plugin-sdk/agent-runtime";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  expectDashscopeVideoTaskPoll,
  expectSuccessfulDashscopeVideoResult,
  mockSuccessfulDashscopeVideoTask,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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

function qwenConfig(provider: Partial<ModelProviderConfig>) {
  return {
    models: {
      providers: {
        qwen: {
          baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
          models: [],
          ...provider,
        },
      },
    },
  };
}

function expectPostJsonRequest(
  call: unknown,
  expected: {
    url: string;
    body: Record<string, unknown>;
    elapsedMs: number;
  },
) {
  if (!call || typeof call !== "object") {
    throw new Error("expected postJsonRequest call object");
  }
  const request = call as {
    url?: unknown;
    headers?: unknown;
    body?: unknown;
    timeoutMs?: unknown;
    fetchFn?: unknown;
    allowPrivateNetwork?: unknown;
    dispatcherPolicy?: unknown;
  };
  expect(request.url).toBe(expected.url);
  expect(request.body).toEqual(expected.body);
  // Submission receives the remaining operation budget after preparation consumes clock ticks.
  expect(request.timeoutMs).toBeGreaterThan(0);
  expect(request.timeoutMs).toBeLessThanOrEqual(120_000);
  expect(request.timeoutMs).toBeGreaterThanOrEqual(120_000 - expected.elapsedMs);
  expect(request.fetchFn).toBe(globalThis.fetch);
  expect(request.allowPrivateNetwork).toBe(false);
  expect(request.dispatcherPolicy).toBeUndefined();
  expect(request.headers).toBeInstanceOf(Headers);
  expect(Array.from((request.headers as Headers).entries())).toEqual([
    ["authorization", "Bearer provider-key"],
    ["content-type", "application/json"],
    ["x-dashscope-async", "enable"],
  ]);
}

describe("qwen video generation provider", () => {
  it("submits async Wan generation, polls task status, and downloads the resulting video", async () => {
    mockSuccessfulDashscopeVideoTask({ postJsonRequestMock, fetchWithTimeoutMock });
    let nowMs = Date.now();
    // Force preparation to cross a clock tick instead of relying on wall-clock timing.
    const clock = vi.spyOn(Date, "now").mockImplementation(() => nowMs++);
    try {
      const startedAt = Date.now();
      const provider = qwenVideoGenerationProvider;
      const result = await provider.generateVideo({
        provider: "qwen",
        model: "wan2.6-r2v-flash",
        prompt: "animate this shot",
        cfg: {},
        inputImages: [{ url: "https://example.com/ref.png" }],
        durationSeconds: 6,
        audio: true,
      });

      expect(postJsonRequestMock).toHaveBeenCalledTimes(1);
      expectPostJsonRequest(postJsonRequestMock.mock.calls[0]?.[0], {
        elapsedMs: Date.now() - startedAt,
        url: "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
        body: {
          model: "wan2.6-r2v-flash",
          input: {
            prompt: "animate this shot",
            reference_urls: ["https://example.com/ref.png"],
          },
          parameters: {
            duration: 6,
            audio: true,
          },
        },
      });
      expectDashscopeVideoTaskPoll(fetchWithTimeoutMock);
      expectSuccessfulDashscopeVideoResult(result);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    ["https://proxy.example.test/vendor-prefix/", "https://proxy.example.test/vendor-prefix"],
  ])("routes Standard endpoint %s to its own regional AIGC host", async (baseUrl, aigcBaseUrl) => {
    mockSuccessfulDashscopeVideoTask({ postJsonRequestMock, fetchWithTimeoutMock });

    await qwenVideoGenerationProvider.generateVideo({
      provider: "qwen",
      model: "wan2.6-t2v",
      prompt: "animate this shot",
      cfg: qwenConfig({
        baseUrl,
      }),
    });

    expect(postJsonRequestMock.mock.calls[0]?.[0]).toMatchObject({
      url: `${aigcBaseUrl}/api/v1/services/aigc/video-generation/video-synthesis`,
    });
    expectDashscopeVideoTaskPoll(fetchWithTimeoutMock, { baseUrl: aigcBaseUrl });
  });

  it.each(["https://coding-intl.dashscope.aliyuncs.com/v1"])(
    "rejects Wan generation through subscription endpoint %s",
    async (baseUrl) => {
      await expect(
        qwenVideoGenerationProvider.generateVideo({
          provider: "qwen",
          model: "wan2.6-t2v",
          prompt: "animate this shot",
          cfg: qwenConfig({
            baseUrl,
          }),
        }),
      ).rejects.toThrow(/Standard DashScope endpoint.*same-region Standard API key/i);

      expect(postJsonRequestMock).not.toHaveBeenCalled();
    },
  );
});

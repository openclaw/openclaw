import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  expectDashscopeVideoTaskPoll,
  expectExplicitVideoGenerationCapabilities,
  expectSuccessfulDashscopeVideoResult,
  mockSuccessfulDashscopeVideoTask,
} from "openclaw/plugin-sdk/provider-test-contracts";
import {
  DASHSCOPE_WAN_VIDEO_MODELS,
  DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL,
} from "openclaw/plugin-sdk/video-generation";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { resolveApiKeyForProviderMock, postJsonRequestMock, fetchWithTimeoutMock } =
  getProviderHttpMocks();

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

function clearQwenAuthEnvironment(): void {
  for (const name of ["QWEN_API_KEY", "MODELSTUDIO_API_KEY", "DASHSCOPE_API_KEY"]) {
    vi.stubEnv(name, "");
  }
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

function streamedVideoResponse(bytes: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(bytes));
        controller.close();
      },
    }),
    { headers: { "content-type": "video/mp4" } },
  );
}

describe("qwen video generation provider", () => {
  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(qwenVideoGenerationProvider);
    expect(qwenVideoGenerationProvider).toMatchObject({
      id: "qwen",
      label: "Qwen Cloud",
      defaultModel: DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL,
      models: [...DASHSCOPE_WAN_VIDEO_MODELS],
    });
  });

  it.each([
    ["sk-ws-qwen-standard-key", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"],
    ["sk-qwen-legacy-standard-key", "https://dashscope.aliyuncs.com/compatible-mode/v1"],
  ])("advertises Standard Qwen video credentials %s", (apiKey, baseUrl) => {
    clearQwenAuthEnvironment();

    expect(
      qwenVideoGenerationProvider.isConfigured?.({
        cfg: qwenConfig({
          apiKey,
          baseUrl,
        }),
      }),
    ).toBe(true);
  });

  it.each([
    "https://coding-intl.dashscope.aliyuncs.com/v1",
    "https://coding.dashscope.aliyuncs.com/v1",
    "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  ])("does not advertise Wan video through subscription endpoint %s", (baseUrl) => {
    clearQwenAuthEnvironment();

    expect(
      qwenVideoGenerationProvider.isConfigured?.({
        cfg: qwenConfig({
          apiKey: "sk-ws-qwen-standard-key",
          baseUrl,
        }),
      }),
    ).toBe(false);
  });

  it("does not advertise a Coding or Token Plan API key on a Standard endpoint", () => {
    clearQwenAuthEnvironment();

    expect(
      qwenVideoGenerationProvider.isConfigured?.({
        cfg: qwenConfig({
          apiKey: "sk-sp-qwen-subscription-key",
          baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        }),
      }),
    ).toBe(false);
  });

  it("does not advertise an inherited Coding Plan environment key", () => {
    clearQwenAuthEnvironment();
    vi.stubEnv("QWEN_API_KEY", "sk-sp-qwen-coding-plan-key");

    expect(qwenVideoGenerationProvider.isConfigured?.({ cfg: {} })).toBe(false);
  });

  it("keeps explicit Standard config above an inherited Coding Plan environment key", () => {
    clearQwenAuthEnvironment();
    vi.stubEnv("QWEN_API_KEY", "sk-sp-qwen-coding-plan-key");

    expect(
      qwenVideoGenerationProvider.isConfigured?.({
        cfg: qwenConfig({
          auth: "api-key",
          apiKey: "sk-ws-qwen-standard-key",
          baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        }),
      }),
    ).toBe(true);
  });

  it.each([
    ["sk-ws-qwen-profile", "sk-sp-qwen-environment", true],
    ["sk-sp-qwen-profile", "sk-ws-qwen-environment", false],
  ])("preserves actual profile precedence for %s", async (profileKey, envKey, expected) => {
    clearQwenAuthEnvironment();
    vi.stubEnv("QWEN_API_KEY", envKey);
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qwen-wan-auth-"));

    try {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "qwen:standard": {
              type: "api_key",
              provider: "qwen",
              key: profileKey,
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false, syncExternalCli: false },
      );

      expect(qwenVideoGenerationProvider.isConfigured?.({ cfg: {}, agentDir })).toBe(expected);
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      await fs.rm(agentDir, { force: true, recursive: true });
    }
  });

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

  it("does not poll after submission exhausts the default operation budget", async () => {
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const release = vi.fn(async () => {
      clock.mockReturnValue(startedAt + 120_000);
    });
    postJsonRequestMock.mockResolvedValueOnce({
      response: Response.json({ output: { task_id: "expired-task" } }),
      release,
    });

    try {
      await expect(
        qwenVideoGenerationProvider.generateVideo({
          provider: "qwen",
          model: "wan2.6-t2v",
          prompt: "animate this shot",
          cfg: {},
        }),
      ).rejects.toThrow("Qwen video generation timed out after 120000ms");
      expect(postJsonRequestMock).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      expect(fetchWithTimeoutGuardedMock).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects DashScope video downloads that exceed the configured media cap", async () => {
    postJsonRequestMock.mockImplementation(async () => ({
      response: Response.json({
        request_id: "req-too-large",
        output: { task_id: "task-too-large" },
      }),
      release: async () => {},
    }));
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        Response.json(
          {
            output: {
              task_status: "SUCCEEDED",
              results: [{ video_url: "https://example.com/too-large.mp4" }],
            },
          },
          { headers: new Headers() },
        ),
      )
      .mockResolvedValueOnce(streamedVideoResponse("too-large"));

    const provider = qwenVideoGenerationProvider;
    await expect(
      provider.generateVideo({
        provider: "qwen",
        model: "wan2.6-t2v",
        prompt: "short video",
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
      }),
    ).rejects.toThrow("Qwen generated video download exceeds 1 bytes");
  });

  it.each([
    [
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      "https://dashscope-intl.aliyuncs.com",
    ],
    ["https://dashscope.aliyuncs.com/compatible-mode/v1", "https://dashscope.aliyuncs.com"],
    ["https://dashscope-us.aliyuncs.com/compatible-mode/v1", "https://dashscope-us.aliyuncs.com"],
    [
      "https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1",
      "https://cn-hongkong.dashscope.aliyuncs.com",
    ],
    [
      "https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      "https://workspace.ap-southeast-1.maas.aliyuncs.com",
    ],
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

  it.each([
    "https://coding-intl.dashscope.aliyuncs.com/v1",
    "https://coding.dashscope.aliyuncs.com/v1",
    "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  ])("rejects Wan generation through subscription endpoint %s", async (baseUrl) => {
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
  });

  it("rejects a resolved Coding Plan API key before submitting a Wan request", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({ apiKey: "sk-sp-qwen-coding-plan-key" });

    await expect(
      qwenVideoGenerationProvider.generateVideo({
        provider: "qwen",
        model: "wan2.6-t2v",
        prompt: "animate this shot",
        cfg: qwenConfig({
          baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        }),
      }),
    ).rejects.toThrow(/Standard DashScope endpoint.*same-region Standard API key/i);

    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });
});

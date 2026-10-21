import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  expectAllowPrivateNetworkPolicy,
  expectMinimaxGuardedFetchCall,
  getMinimaxProviderHttpMocks,
  installMinimaxProviderHttpMockCleanup,
  loadMinimaxVideoGenerationProviderModule,
  mockCallArg,
} from "./provider-http.test-helpers.js";

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  executeProviderOperationWithRetryMock,
  fetchWithTimeoutMock,
  resolveProviderHttpRequestConfigMock,
} = getMinimaxProviderHttpMocks();

let buildMinimaxVideoGenerationProvider: Awaited<
  ReturnType<typeof loadMinimaxVideoGenerationProviderModule>
>["buildMinimaxVideoGenerationProvider"];
beforeAll(async () => {
  ({ buildMinimaxVideoGenerationProvider } = await loadMinimaxVideoGenerationProviderModule());
});

installMinimaxProviderHttpMockCleanup();

const requestOverrides = {
  allowPrivateNetwork: true,
  headers: { "X-MiniMax-Video-Policy": "enabled" },
};

function videoConfig(provider = "minimax", baseUrl = "https://api.minimax.io") {
  return {
    models: { providers: { [provider]: { baseUrl, models: [], request: requestOverrides } } },
  };
}

function mockVideoDownload(mimeType = "video/mp4", bytes = "mp4-bytes") {
  fetchWithTimeoutMock.mockResolvedValueOnce({
    headers: new Headers({ "content-type": mimeType }),
    arrayBuffer: async () => Buffer.from(bytes),
  });
}

function expectPolicyFetch(index: number, url: string) {
  const call = expectMinimaxGuardedFetchCall(index, url);
  expect((call.init.headers as Headers).get("x-minimax-video-policy")).toBe("enabled");
  expectAllowPrivateNetworkPolicy(call.options);
}

function videoRequest(overrides: Partial<VideoGenerationRequest> = {}): VideoGenerationRequest {
  return {
    provider: "minimax",
    model: "MiniMax-Hailuo-2.3",
    prompt: "A fox sprints across snowy hills",
    cfg: {},
    ...overrides,
  };
}

function expectMinimaxFetchCall(index: number, url: string) {
  const call = fetchWithTimeoutMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected MiniMax fetch call ${index + 1}`);
  }
  const [actualUrl, init, timeoutMs, fetchFn] = call;
  expect(actualUrl).toBe(url);
  expect(init).toMatchObject({ method: "GET" });
  expect(Number.isInteger(timeoutMs)).toBe(true);
  expect(timeoutMs).toBeGreaterThan(0);
  expect(fetchFn).toBe(fetch);
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
}

function mockVideoTask(taskId: string, completed: Record<string, unknown>): void {
  postJsonRequestMock.mockResolvedValue({
    response: jsonResponse({ task_id: taskId, base_resp: { status_code: 0 } }),
    release: vi.fn(async () => {}),
  });
  fetchWithTimeoutMock.mockResolvedValueOnce(
    jsonResponse({
      task_id: taskId,
      status: "Success",
      base_resp: { status_code: 0 },
      ...completed,
    }),
  );
}

function oversizedJsonResponse(): Response {
  return new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024).fill(0x20));
      },
      cancel: vi.fn(),
    }),
    { headers: { "content-type": "application/json" } },
  );
}

describe("minimax video generation provider", () => {
  it.each(["minimax", "minimax-portal"])(
    "rejects an invalid %s media origin before resolving credentials or submitting video",
    async (providerId) => {
      await expect(
        buildMinimaxVideoGenerationProvider(providerId).generateVideo(
          videoRequest({
            provider: providerId,
            cfg: {
              models: {
                providers: { [providerId]: { baseUrl: "https://[", models: [] } },
              },
            },
          }),
        ),
      ).rejects.toBeInstanceOf(TypeError);
      expect(resolveApiKeyForProviderMock).not.toHaveBeenCalled();
      expect(postJsonRequestMock).not.toHaveBeenCalled();
      expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    },
  );

  it("rejects a duration that rounds to zero before submission", async () => {
    await expect(
      buildMinimaxVideoGenerationProvider().generateVideo(videoRequest({ durationSeconds: 0.4 })),
    ).rejects.toThrow("durationSeconds must be a positive duration");
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it.each(["constructor", "__proto__", "hasOwnProperty", "unknown-model"])(
    "preserves requested options for unknown model %s without inherited constraints",
    async (model) => {
      mockVideoTask("unknown-model-task", { video_url: "https://example.com/out.mp4" });
      mockVideoDownload("video/mp4", "synthetic-video");
      await buildMinimaxVideoGenerationProvider().generateVideo(
        videoRequest({ model, durationSeconds: 5, resolution: "720P" }),
      );
      expect(mockCallArg(postJsonRequestMock).body).toMatchObject({
        model,
        duration: 5,
        resolution: "720P",
      });
    },
  );

  it("creates a task, polls status, and downloads the generated video", async () => {
    mockVideoTask("task-123", { video_url: "https://example.com/out.mp4", file_id: "file-1" });
    mockVideoDownload("video/webm", "webm-bytes");

    const provider = buildMinimaxVideoGenerationProvider();
    const result = await provider.generateVideo(
      videoRequest({ durationSeconds: 5, resolution: "720P" }),
    );

    const request = mockCallArg(postJsonRequestMock);
    expect(request.url).toBe("https://api.minimax.io/v1/video_generation");
    expect(request.body).toMatchObject({ duration: 6, resolution: "768P" });
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.fileName).toBe("video-1.webm");
    expect(result.metadata).toMatchObject({ taskId: "task-123", fileId: "file-1" });
  });

  it.each([{ name: "missing", filename: undefined, expectedFileName: "video-1.webm" }])(
    "downloads via file_id with a $name filename when status omits video_url",
    async ({ filename, expectedFileName }) => {
      mockVideoTask("task-456", { file_id: "file-9" });
      fetchWithTimeoutMock.mockResolvedValueOnce(
        jsonResponse({
          file: {
            file_id: "file-9",
            filename,
            download_url: "https://example.com/download.mp4",
          },
          base_resp: { status_code: 0 },
        }),
      );
      mockVideoDownload("video/webm", "webm-bytes");

      const provider = buildMinimaxVideoGenerationProvider();
      const result = await provider.generateVideo(videoRequest({ cfg: videoConfig() }));

      expectMinimaxFetchCall(1, "https://api.minimax.io/v1/files/retrieve?file_id=file-9");
      expectMinimaxFetchCall(2, "https://example.com/download.mp4");
      expectPolicyFetch(0, "https://api.minimax.io/v1/query/video_generation?task_id=task-456");
      expectPolicyFetch(1, "https://api.minimax.io/v1/files/retrieve?file_id=file-9");
      expectAllowPrivateNetworkPolicy(
        expectMinimaxGuardedFetchCall(2, "https://example.com/download.mp4").options,
      );
      expect(result.videos).toHaveLength(1);
      expect(result.videos[0]).toMatchObject({
        buffer: Buffer.from("webm-bytes"),
        mimeType: "video/webm",
        fileName: expectedFileName,
      });
      expect(result.metadata).toMatchObject({ taskId: "task-456", fileId: "file-9" });
      expect(result.metadata?.videoUrl).toBeUndefined();
    },
  );

  it("retries guarded video status polling while preserving request policy", async () => {
    fetchWithTimeoutMock.mockRejectedValueOnce(new Error("request timeout"));
    mockVideoTask("task-retry", { video_url: "https://example.com/retry.mp4" });
    mockVideoDownload();

    const provider = buildMinimaxVideoGenerationProvider();
    const result = await provider.generateVideo(videoRequest({ cfg: videoConfig() }));

    expectPolicyFetch(0, "https://api.minimax.io/v1/query/video_generation?task_id=task-retry");
    expectPolicyFetch(1, "https://api.minimax.io/v1/query/video_generation?task_id=task-retry");
    expect(result.videos).toHaveLength(1);
    expect(
      executeProviderOperationWithRetryMock.mock.calls.map(
        ([params]) => (params as { stage: string }).stage,
      ),
    ).toContain("poll");
  });

  it("rejects oversized file_id metadata JSON before downloading", async () => {
    mockVideoTask("task-metadata-too-large", { file_id: "file-too-large" });
    fetchWithTimeoutMock.mockResolvedValueOnce(oversizedJsonResponse());

    const provider = buildMinimaxVideoGenerationProvider();
    await expect(provider.generateVideo(videoRequest())).rejects.toThrow(
      "MiniMax generated video metadata: JSON response exceeds 16777216 bytes",
    );

    expectMinimaxFetchCall(1, "https://api.minimax.io/v1/files/retrieve?file_id=file-too-large");
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it("routes portal video generation through minimax-portal auth and HTTP config", async () => {
    mockVideoTask("task-portal", { video_url: "https://example.com/portal.mp4" });
    mockVideoDownload();

    const provider = buildMinimaxVideoGenerationProvider("minimax-portal");
    await provider.generateVideo(
      videoRequest({
        provider: "minimax-portal",
        prompt: "A neon city street at night",
        cfg: {
          models: {
            providers: {
              minimax: { baseUrl: "https://wrong.example/anthropic", models: [] },
              ...videoConfig("minimax-portal", "https://api.minimaxi.com/anthropic").models
                .providers,
            },
          },
        },
      }),
    );

    expect(mockCallArg(resolveApiKeyForProviderMock).provider).toBe("minimax-portal");
    const httpConfigParams = mockCallArg(resolveProviderHttpRequestConfigMock);
    expect(httpConfigParams).toMatchObject({
      baseUrl: "https://api.minimaxi.com",
      provider: "minimax-portal",
      capability: "video",
      transport: "http",
    });
    expect(httpConfigParams.request).toEqual(requestOverrides);
    const postParams = mockCallArg(postJsonRequestMock);
    expect(postParams.allowPrivateNetwork).toBe(true);
    expect((postParams.headers as Headers).get("x-minimax-video-policy")).toBe("enabled");
    expect(postParams.url).toBe("https://api.minimaxi.com/v1/video_generation");
    expectPolicyFetch(0, "https://api.minimaxi.com/v1/query/video_generation?task_id=task-portal");
    expectAllowPrivateNetworkPolicy(
      expectMinimaxGuardedFetchCall(1, "https://example.com/portal.mp4").options,
    );
  });
});

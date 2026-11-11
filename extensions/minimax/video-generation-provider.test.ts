import type { MusicGenerationRequest } from "openclaw/plugin-sdk/music-generation";
import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  cancelTrackedTextResponse,
  createStreamingResponse,
} from "../test-support/streaming-error-response.js";
import {
  expectAllowPrivateNetworkPolicy,
  expectMinimaxGuardedFetchCall,
  getMinimaxProviderHttpMocks,
  installMinimaxProviderHttpMockCleanup,
  loadMinimaxVideoGenerationProviderModule,
  loadMinimaxMusicGenerationProviderModule,
  mockCallArg,
} from "./provider-http.test-helpers.js";

const {
  resolveApiKeyForProviderMock: auth,
  postJsonRequestMock: post,
  executeProviderOperationWithRetryMock: retry,
  fetchWithTimeoutMock: download,
  fetchWithTimeoutGuardedMock: guarded,
  resolveProviderHttpRequestConfigMock: httpConfig,
} = getMinimaxProviderHttpMocks();

let buildMinimaxVideoGenerationProvider: Awaited<
  ReturnType<typeof loadMinimaxVideoGenerationProviderModule>
>["buildMinimaxVideoGenerationProvider"];
let buildMinimaxMusicGenerationProvider: Awaited<
  ReturnType<typeof loadMinimaxMusicGenerationProviderModule>
>["buildMinimaxMusicGenerationProvider"];
beforeAll(async () => {
  ({ buildMinimaxVideoGenerationProvider } = await loadMinimaxVideoGenerationProviderModule());
  ({ buildMinimaxMusicGenerationProvider } = await loadMinimaxMusicGenerationProviderModule());
});

installMinimaxProviderHttpMockCleanup();

const requestOverrides = {
  allowPrivateNetwork: true,
  headers: { "X-MiniMax-Video-Policy": "enabled" },
};

function videoConfig(provider = "minimax", baseUrl = "https://api.minimax.io") {
  return mediaConfig(provider, baseUrl, requestOverrides);
}

function mockDownload(mimeType = "video/mp4", bytes = "mp4-bytes") {
  download.mockResolvedValueOnce({
    headers: new Headers({ "content-type": mimeType }),
    arrayBuffer: async () => Buffer.from(bytes),
  });
}

function expectPolicyFetch(index: number, url: string) {
  const call = expectMinimaxGuardedFetchCall(index, url);
  expect((call.init.headers as Headers).get("x-minimax-video-policy")).toBe("enabled");
  expectAllowPrivateNetworkPolicy(call.options);
}

function generateVideo(overrides: Partial<VideoGenerationRequest> = {}) {
  const request: VideoGenerationRequest = {
    provider: "minimax",
    model: "MiniMax-Hailuo-2.3",
    prompt: "A fox sprints across snowy hills",
    cfg: {},
    ...overrides,
  };
  return buildMinimaxVideoGenerationProvider(request.provider).generateVideo(request);
}

function mockVideoTask(taskId: string, completed: Record<string, unknown>): void {
  mockJson({ task_id: taskId });
  download.mockResolvedValueOnce(
    Response.json({
      task_id: taskId,
      status: "Success",
      base_resp: { status_code: 0 },
      ...completed,
    }),
  );
}

describe.each([
  ["video", generateVideo],
  ["music", generateMusic],
] as const)("%s media origin", (_kind, generate) => {
  it.each(["minimax", "minimax-portal"])(
    "rejects invalid %s origins before I/O",
    async (provider) => {
      await expect(
        generate({ provider, cfg: mediaConfig(provider, "https://[") }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(auth).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(download).not.toHaveBeenCalled();
    },
  );
});

describe("minimax video generation provider", () => {
  it("rejects a duration that rounds to zero before submission", async () => {
    await expect(generateVideo({ durationSeconds: 0.4 })).rejects.toThrow(
      "durationSeconds must be a positive duration",
    );
    expect(post).not.toHaveBeenCalled();
  });

  it.each(["constructor", "__proto__", "hasOwnProperty", "unknown-model"])(
    "preserves requested options for unknown model %s without inherited constraints",
    async (model) => {
      mockVideoTask("unknown-model-task", { video_url: "https://example.com/out.mp4" });
      mockDownload("video/mp4", "synthetic-video");
      await generateVideo({ model, durationSeconds: 5, resolution: "720P" });
      expect(mockCallArg(post).body).toMatchObject({
        model,
        duration: 5,
        resolution: "720P",
      });
    },
  );

  it("creates a task, polls status, and downloads the generated video", async () => {
    mockVideoTask("task-123", { video_url: "https://example.com/out.mp4", file_id: "file-1" });
    mockDownload("video/webm", "webm-bytes");

    const result = await generateVideo({ durationSeconds: 5, resolution: "720P" });

    const request = mockCallArg(post);
    expect(request).toMatchObject({
      url: "https://api.minimax.io/v1/video_generation",
      body: { duration: 6, resolution: "768P" },
    });
    expect(result).toMatchObject({
      videos: [{ fileName: "video-1.webm" }],
      metadata: { taskId: "task-123", fileId: "file-1" },
    });
  });

  it("downloads via file_id with a missing filename when status omits video_url", async () => {
    mockVideoTask("task-456", { file_id: "file-9" });
    download.mockResolvedValueOnce(
      Response.json({
        file: { file_id: "file-9", download_url: "https://example.com/download.mp4" },
        base_resp: { status_code: 0 },
      }),
    );
    mockDownload("video/webm", "webm-bytes");

    const result = await generateVideo({ cfg: videoConfig() });

    expectPolicyFetch(0, "https://api.minimax.io/v1/query/video_generation?task_id=task-456");
    expectPolicyFetch(1, "https://api.minimax.io/v1/files/retrieve?file_id=file-9");
    expectAllowPrivateNetworkPolicy(
      expectMinimaxGuardedFetchCall(2, "https://example.com/download.mp4").options,
    );
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]).toMatchObject({
      buffer: Buffer.from("webm-bytes"),
      mimeType: "video/webm",
      fileName: "video-1.webm",
    });
    expect(result.metadata).toMatchObject({ taskId: "task-456", fileId: "file-9" });
    expect(result.metadata?.videoUrl).toBeUndefined();
  });

  it("retries guarded video status polling while preserving request policy", async () => {
    download.mockRejectedValueOnce(new Error("request timeout"));
    mockVideoTask("task-retry", { video_url: "https://example.com/retry.mp4" });
    mockDownload();

    const result = await generateVideo({ cfg: videoConfig() });

    expectPolicyFetch(0, "https://api.minimax.io/v1/query/video_generation?task_id=task-retry");
    expectPolicyFetch(1, "https://api.minimax.io/v1/query/video_generation?task_id=task-retry");
    expect(result.videos).toHaveLength(1);
    expect(retry.mock.calls.map(([params]) => (params as { stage: string }).stage)).toContain(
      "poll",
    );
  });

  it("rejects oversized file_id metadata JSON before downloading", async () => {
    mockVideoTask("task-metadata-too-large", { file_id: "file-too-large" });
    download.mockResolvedValueOnce(
      createStreamingResponse({
        chunkCount: Infinity,
        chunkSize: 1024 * 1024,
        byte: 0x20,
        headers: { "content-type": "application/json" },
      }).response,
    );

    await expect(generateVideo()).rejects.toThrow(
      "MiniMax generated video metadata: JSON response exceeds 16777216 bytes",
    );

    expectMinimaxGuardedFetchCall(
      1,
      "https://api.minimax.io/v1/files/retrieve?file_id=file-too-large",
    );
    expect(download).toHaveBeenCalledTimes(2);
  });

  it("routes portal video generation through minimax-portal auth and HTTP config", async () => {
    mockVideoTask("task-portal", { video_url: "https://example.com/portal.mp4" });
    mockDownload();

    await generateVideo({
      provider: "minimax-portal",
      prompt: "A neon city street at night",
      cfg: {
        models: {
          providers: {
            minimax: { baseUrl: "https://wrong.example/anthropic", models: [] },
            ...videoConfig("minimax-portal", "https://api.minimaxi.com/anthropic").models.providers,
          },
        },
      },
    });

    expect(mockCallArg(auth).provider).toBe("minimax-portal");
    const httpConfigParams = mockCallArg(httpConfig);
    expect(httpConfigParams).toMatchObject({
      baseUrl: "https://api.minimaxi.com",
      provider: "minimax-portal",
      capability: "video",
      transport: "http",
    });
    expect(httpConfigParams.request).toEqual(requestOverrides);
    const postParams = mockCallArg(post);
    expect(postParams.allowPrivateNetwork).toBe(true);
    expect((postParams.headers as Headers).get("x-minimax-video-policy")).toBe("enabled");
    expect(postParams.url).toBe("https://api.minimaxi.com/v1/video_generation");
    expectPolicyFetch(0, "https://api.minimaxi.com/v1/query/video_generation?task_id=task-portal");
    expectAllowPrivateNetworkPolicy(
      expectMinimaxGuardedFetchCall(1, "https://example.com/portal.mp4").options,
    );
  });
});

function generateMusic(overrides: Partial<MusicGenerationRequest> = {}) {
  const request: MusicGenerationRequest = {
    provider: "minimax",
    model: "music-2.6",
    prompt: "upbeat dance-pop with female vocals",
    cfg: {},
    ...overrides,
  };
  return buildMinimaxMusicGenerationProvider(request.provider).generateMusic(request);
}

function mediaConfig(
  provider: string,
  baseUrl: string,
  request?: { allowPrivateNetwork: boolean; headers: Record<string, string> },
) {
  return { models: { providers: { [provider]: { baseUrl, models: [], request } } } };
}

function mockResponse(body: BodyInit, contentType = "text/event-stream"): void {
  post.mockResolvedValue({
    response: new Response(body, { headers: { "content-type": contentType } }),
    release: vi.fn(async () => {}),
  });
}

function mockJson(json: Record<string, unknown>): void {
  mockResponse(JSON.stringify({ base_resp: { status_code: 0 }, ...json }), "application/json");
}

function streamFrame(data: Record<string, unknown>, status_code = 0, status_msg?: string) {
  return `data: ${JSON.stringify({ data, base_resp: { status_code, status_msg } })}\n\n`;
}

function expectDownloadFetchTimeout(url: string, totalTimeoutMs: number): void {
  const call = download.mock.calls[0];
  if (!call) {
    throw new Error("expected generated music download");
  }
  const [actualUrl, init, timeoutMs, fetchFn] = call;
  expect(actualUrl).toBe(url);
  expect(init).toEqual({ method: "GET" });
  expect(timeoutMs).toBeGreaterThan(totalTimeoutMs - 1_000);
  expect(timeoutMs).toBeLessThanOrEqual(totalTimeoutMs);
  expect(fetchFn).toBe(fetch);
}

describe("minimax music generation provider", () => {
  it("streams generated music chunks from MiniMax", async () => {
    using clock = vi.spyOn(performance, "now");
    clock.mockReturnValue(0);
    const chunkA = Buffer.from("ID3\x04\x00mp3-a");
    const chunkB = Buffer.from("mp3-b");
    mockResponse(
      streamFrame({ status: 1, audio: chunkA.toString("hex") }) +
        streamFrame({ status: 1, audio: chunkB.toString("hex") }) +
        streamFrame({ status: 2, audio: Buffer.concat([chunkA, chunkB]).toString("hex") }),
    );
    const result = await generateMusic({
      model: "",
      lyrics: "our city wakes",
      durationSeconds: 45,
      cfg: mediaConfig("minimax", "   "),
    });
    const request = mockCallArg(post);
    expect(request.url).toBe("https://api.minimax.io/v1/music_generation");
    expect(request.body).toEqual({
      model: "music-2.6",
      prompt: "upbeat dance-pop with female vocals",
      lyrics: "our city wakes",
      stream: true,
      output_format: "hex",
      audio_setting: { sample_rate: 44100, bitrate: 256000, format: "mp3" },
    });
    expect(request.timeoutMs).toBeGreaterThan(299_000);
    expect(request.timeoutMs).toBeLessThanOrEqual(300_000);
    expect(request?.headers).toBeInstanceOf(Headers);
    expect((request.headers as Headers).get("content-type")).toBe("application/json");
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]?.buffer).toEqual(Buffer.concat([chunkA, chunkB]));
    expect(result.tracks[0]?.mimeType).toBe("audio/mpeg");
    expect(result.metadata?.requestedLyrics).toBe(true);
    expect(result.metadata).not.toHaveProperty("requestedDurationSeconds");
  });

  it("cancels invalid music responses before releasing their guarded dispatcher", async () => {
    const tracked = cancelTrackedTextResponse('{"error":"still streaming"}', {
      headers: { "content-type": "application/json" },
    });
    let canceledAtRelease = false;
    const release = vi.fn(async () => {
      canceledAtRelease = tracked.wasCanceled();
    });
    mockJson({ data: { audio_url: "https://example.com/invalid-open.mp3" } });
    guarded.mockResolvedValueOnce({
      response: tracked.response,
      finalUrl: "https://example.com/invalid-open.mp3",
      release,
    });

    await expect(generateMusic({ prompt: "invalid download" })).rejects.toThrow(
      "MiniMax generated music download: malformed audio response",
    );
    expect(release).toHaveBeenCalledOnce();
    expect(canceledAtRelease).toBe(true);
  });

  it.each([
    [
      streamFrame({ status: 1, audio: "ZE==" }),
      "MiniMax music generation returned malformed hex audio",
      "text/event-stream",
    ],
    [
      streamFrame({}) + streamFrame({}, 2013, "render rejected"),
      "MiniMax music generation failed (2013): render rejected",
      "text/event-stream",
    ],
    ...["{}", "null", "false"].map((body) => [
      body,
      "MiniMax music generation stream ended without completion",
      "application/json",
    ]),
  ])("rejects invalid music response %s", async (body, message, contentType) => {
    const release = vi.fn(async () => {});
    post.mockResolvedValueOnce({
      response: new Response(body, { headers: { "content-type": contentType } }),
      release,
    });
    await expect(generateMusic()).rejects.toThrow(message);
    expect(release).toHaveBeenCalledOnce();
  });

  it("preserves the deadline error when JSON without audio finishes after its budget", async () => {
    using clock = vi.spyOn(performance, "now").mockReturnValue(0);
    mockResponse(
      new ReadableStream<Uint8Array>(
        {
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{}"));
          },
          pull(controller) {
            clock.mockReturnValue(50);
            controller.close();
          },
        },
        { highWaterMark: 0 },
      ),
      "application/json",
    );
    await expect(generateMusic({ timeoutMs: 50 })).rejects.toThrow(
      "MiniMax music generation timed out after 50ms",
    );
  });

  it("rejects inline generated music that exceeds the configured media cap before decoding", async () => {
    mockJson({ data: { audio: Buffer.from("too-large").toString("hex") } });
    await expect(
      generateMusic({ cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } } }),
    ).rejects.toThrow("MiniMax generated music download exceeds 1 bytes");
  });

  it("downloads tracks when url output is returned in data.audio", async () => {
    mockJson({
      task_id: " task-url ",
      lyrics: "our city wakes",
      data: { audio: " https://example.com/url-audio.mp3 " },
    });
    mockDownload("audio/mpeg", "mp3-bytes");
    const result = await generateMusic({ lyrics: "our city wakes" });
    expectDownloadFetchTimeout("https://example.com/url-audio.mp3", 120_000);
    expect(result.tracks[0]?.buffer.byteLength).toBeGreaterThan(0);
    expect(result.lyrics).toEqual(["our city wakes"]);
    expect(result.metadata).toMatchObject({
      taskId: "task-url",
      audioUrl: "https://example.com/url-audio.mp3",
    });
  });

  it("applies explicit caller timeouts while reading streaming response bodies", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            if (cancelled) {
              return;
            }
            controller.enqueue(
              new TextEncoder().encode(
                streamFrame({ status: 2, audio: Buffer.from("late-mp3").toString("hex") }),
              ),
            );
            controller.close();
          }, 200);
        },
        cancel() {
          cancelled = true;
        },
      });
      mockResponse(stream);
      const generation = generateMusic({ timeoutMs: 50 });
      const expectation = expect(generation).rejects.toThrow(
        "MiniMax music generation timed out after 50ms",
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(50);
      await expectation;
      expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects instrumental requests that also include lyrics", async () => {
    await expect(
      generateMusic({ prompt: "driving techno", instrumental: true, lyrics: "do not sing this" }),
    ).rejects.toThrow("cannot use lyrics when instrumental=true");
  });

  it("retries guarded music URL downloads while preserving request policy", async () => {
    const musicPolicy = {
      allowPrivateNetwork: true,
      headers: { "X-MiniMax-Music-Policy": "enabled" },
    };
    mockJson({ task_id: "task-retry", audio_url: "https://example.com/retry.mp3" });
    download.mockRejectedValueOnce(new Error("request timeout"));
    mockDownload("audio/mpeg", "mp3-bytes");
    const result = await generateMusic({
      provider: "minimax-portal",
      prompt: "upbeat dance-pop",
      cfg: mediaConfig("minimax-portal", "https://api.minimaxi.com", musicPolicy),
    });

    for (const attempt of [0, 1]) {
      expectAllowPrivateNetworkPolicy(
        expectMinimaxGuardedFetchCall(attempt, "https://example.com/retry.mp3").options,
      );
    }
    expect(result.tracks).toHaveLength(1);
    expect(retry.mock.calls.map(([params]) => (params as { stage: string }).stage)).toContain(
      "download",
    );
  });
});

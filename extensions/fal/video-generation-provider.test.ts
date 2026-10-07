import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import * as providerHttp from "openclaw/plugin-sdk/provider-http";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFalVideoGenerationProvider } from "./video-generation-provider.js";

const { fetchGuardMock } = vi.hoisted(() => ({
  fetchGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchGuardMock,
}));

const queueSubmission = {
  request_id: "req-123",
  status_url: "https://queue.fal.run/fal-ai/minimax/requests/req-123/status",
  response_url: "https://queue.fal.run/fal-ai/minimax/requests/req-123",
};

function generateVideo(request: Partial<VideoGenerationRequest> = {}) {
  return buildFalVideoGenerationProvider().generateVideo({
    provider: "fal",
    model: "fal-ai/minimax/video-01-live",
    prompt: "Animate this",
    cfg: {},
    ...request,
  });
}

describe("fal video generation provider", () => {
  function mockFalProviderRuntime() {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-key",
      source: "env",
      mode: "api-key",
    });
    vi.spyOn(providerHttp, "resolveProviderHttpRequestConfig").mockReturnValue({
      baseUrl: "https://fal.run",
      allowPrivateNetwork: false,
      headers: new Headers({
        Authorization: "Key fal-key",
        "Content-Type": "application/json",
      }),
      dispatcherPolicy: undefined,
    });
    vi.spyOn(providerHttp, "assertOkOrThrowHttpError").mockResolvedValue(undefined);
  }

  function releasedJson(value: unknown) {
    return {
      response: Response.json(value),
      release: vi.fn(async () => {}),
    };
  }

  function releasedVideo(params: { contentType: string; bytes: string }) {
    return {
      response: new Response(Buffer.from(params.bytes), {
        status: 200,
        headers: { "content-type": params.contentType },
      }),
      release: vi.fn(async () => {}),
    };
  }

  function mockCompletedFalVideoJob(
    params: {
      bytes?: string;
      contentType?: string;
      responseExtras?: Record<string, unknown>;
    } = {},
  ) {
    fetchGuardMock
      .mockResolvedValueOnce(releasedJson(queueSubmission))
      .mockResolvedValueOnce(releasedJson({ status: "COMPLETED" }))
      .mockResolvedValueOnce(
        releasedJson({
          status: "COMPLETED",
          response: { video: { url: "https://fal.run/files/video.mp4" }, ...params.responseExtras },
        }),
      )
      .mockResolvedValueOnce(
        releasedVideo({
          contentType: params.contentType ?? "video/mp4",
          bytes: params.bytes ?? "mp4-bytes",
        }),
      );
  }

  function requireFetchGuardCall(callNumber: number): { init?: RequestInit; url?: string } {
    const call = fetchGuardMock.mock.calls[callNumber - 1];
    if (!call) {
      throw new Error(`expected fal fetch guard call ${callNumber}`);
    }
    const [request] = call;
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new Error(`expected fal fetch guard request ${callNumber}`);
    }
    return request as { init?: RequestInit; url?: string };
  }

  function getSubmitBody(): Record<string, unknown> {
    const body = requireFetchGuardCall(1).init?.body;
    if (typeof body !== "string") {
      throw new Error("expected fal submit JSON body");
    }
    return JSON.parse(body) as Record<string, unknown>;
  }

  function fetchGuardUrl(callNumber: number): string | undefined {
    return requireFetchGuardCall(callNumber).url;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    fetchGuardMock.mockReset();
  });

  it("declares explicit mode capabilities", () => {
    const provider = buildFalVideoGenerationProvider();
    expectExplicitVideoGenerationCapabilities(provider);
    expect(provider.capabilities.imageToVideo?.maxInputImages).toBe(1);
    expect(
      provider.capabilities.imageToVideo?.maxInputImagesByModel?.[
        "bytedance/seedance-2.0/fast/reference-to-video"
      ],
    ).toBe(9);
    expect(provider.capabilities.videoToVideo?.maxInputVideos).toBe(0);
    expect(
      Object.keys(provider.capabilities.videoToVideo?.supportedDurationSecondsByModel ?? {}),
    ).toEqual([
      "bytedance/seedance-2.0/fast/reference-to-video",
      "bytedance/seedance-2.0/reference-to-video",
    ]);
  });

  it("submits fal video jobs through the queue API and downloads the completed result", async () => {
    mockFalProviderRuntime();
    mockCompletedFalVideoJob({
      bytes: "webm-bytes",
      contentType: "video/webm",
    });

    const result = await generateVideo({
      prompt: "A spaceship emerges from the clouds",
      durationSeconds: 5,
      aspectRatio: "16:9",
      resolution: "720P",
    });

    expect(fetchGuardUrl(1)).toBe("https://queue.fal.run/fal-ai/minimax/video-01-live");
    const submitBody = getSubmitBody();
    expect(submitBody).toEqual({
      prompt: "A spaceship emerges from the clouds",
    });
    expect(fetchGuardUrl(2)).toBe("https://queue.fal.run/fal-ai/minimax/requests/req-123/status");
    expect(fetchGuardUrl(3)).toBe("https://queue.fal.run/fal-ai/minimax/requests/req-123");
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.mimeType).toBe("video/webm");
    expect(result.videos[0]?.fileName).toBe("video-1.webm");
    expect(result.videos[0]?.url).toBe("https://fal.run/files/video.mp4");
    expect(result.metadata).toEqual({
      requestId: "req-123",
    });
  });

  it("parses raw fal queue result payloads with top-level video output", async () => {
    mockFalProviderRuntime();
    fetchGuardMock
      .mockResolvedValueOnce(releasedJson(queueSubmission))
      .mockResolvedValueOnce(releasedJson({ status: "COMPLETED" }))
      .mockResolvedValueOnce(
        releasedJson({
          video: { url: "https://fal.run/files/raw-output.mp4" },
          prompt: "A calm harbor at sunrise",
          seed: 443600358,
        }),
      )
      .mockResolvedValueOnce(releasedVideo({ contentType: "video/mp4", bytes: "mp4-bytes" }));

    const result = await generateVideo({
      model: "fal-ai/wan/v2.2-a14b/image-to-video",
      prompt: "A calm harbor at sunrise",
    });

    expect(result.videos[0]?.url).toBe("https://fal.run/files/raw-output.mp4");
    expect(result.metadata).toEqual({
      requestId: "req-123",
      prompt: "A calm harbor at sunrise",
      seed: 443600358,
    });
  });

  it("returns URL-only videos when generated video downloads exceed the configured media cap", async () => {
    mockFalProviderRuntime();
    mockCompletedFalVideoJob({
      bytes: "too-large",
    });

    const result = await generateVideo({
      prompt: "A spaceship emerges from the clouds",
      cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
    });

    expect(result.videos).toEqual([
      {
        url: "https://fal.run/files/video.mp4",
        mimeType: "video/mp4",
        fileName: "video-1.mp4",
      },
    ]);
  });

  it("rejects an empty generated video", async () => {
    mockFalProviderRuntime();
    mockCompletedFalVideoJob({
      bytes: "",
    });

    await expect(generateVideo()).rejects.toThrow(
      "fal generated video download: malformed video response",
    );
  });

  it("rejects malformed generated video downloads instead of returning URL-only videos", async () => {
    mockFalProviderRuntime();
    mockCompletedFalVideoJob({
      bytes: '{"error":"denied"}',
      contentType: "application/json",
    });

    await expect(
      generateVideo({
        prompt: "invalid download under a tiny media cap",
        // The same cap that turns oversized downloads into URL-only videos above.
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
      }),
    ).rejects.toThrow("fal generated video download: malformed video response");
  });

  it("wraps malformed successful fal submit responses", async () => {
    mockFalProviderRuntime();
    fetchGuardMock.mockResolvedValueOnce(releasedJson([]));

    await expect(generateVideo()).rejects.toThrow("fal video generation response malformed");
  });

  it("wraps non-JSON successful fal submit responses", async () => {
    mockFalProviderRuntime();
    fetchGuardMock.mockResolvedValueOnce({
      response: new Response("<html><body>Bad Gateway</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
      release: vi.fn(async () => {}),
    });

    await expect(generateVideo()).rejects.toThrow("fal video generation response malformed");
  });

  it.each([
    {
      name: "rejects missing fal queue statuses without waiting for timeout",
      response: {},
      prompt: "missing status",
    },
    {
      name: "rejects unknown fal queue statuses without waiting for timeout",
      response: { status: "ALMOST_DONE" },
      prompt: "bad status",
    },
  ])("$name", async ({ response, prompt }) => {
    mockFalProviderRuntime();
    fetchGuardMock
      .mockResolvedValueOnce(releasedJson(queueSubmission))
      .mockResolvedValueOnce(releasedJson(response));

    await expect(generateVideo({ prompt })).rejects.toThrow(
      "fal video generation response malformed",
    );
    expect(fetchGuardMock).toHaveBeenCalledTimes(2);
  });

  it("caps oversized fal queue operation deadlines", async () => {
    mockFalProviderRuntime();
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(MAX_TIMER_TIMEOUT_MS + 1);
    fetchGuardMock
      .mockResolvedValueOnce(releasedJson(queueSubmission))
      .mockResolvedValueOnce(releasedJson({ status: "IN_PROGRESS" }));

    await expect(
      generateVideo({
        prompt: "huge timeout",
        timeoutMs: Number.MAX_SAFE_INTEGER,
      }),
    ).rejects.toThrow("fal video generation did not finish in time (last status: IN_PROGRESS)");
    expect(fetchGuardMock).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed fal completed result payloads", async () => {
    mockFalProviderRuntime();
    fetchGuardMock
      .mockResolvedValueOnce(releasedJson(queueSubmission))
      .mockResolvedValueOnce(releasedJson({ status: "COMPLETED" }))
      .mockResolvedValueOnce(releasedJson({ status: "COMPLETED", response: [] }));

    await expect(generateVideo()).rejects.toThrow("fal video generation response malformed");
  });

  it("submits HeyGen video-agent requests without unsupported fal controls", async () => {
    mockFalProviderRuntime();
    mockCompletedFalVideoJob();

    const result = await generateVideo({
      model: "fal-ai/heygen/v2/video-agent",
      prompt: "A founder explains OpenClaw in a concise studio video",
      durationSeconds: 8,
      aspectRatio: "16:9",
      resolution: "720P",
      audio: true,
    });

    expect(fetchGuardUrl(1)).toBe("https://queue.fal.run/fal-ai/heygen/v2/video-agent");
    expect(getSubmitBody()).toEqual({
      prompt: "A founder explains OpenClaw in a concise studio video",
    });
    expect(result.metadata).toEqual({
      requestId: "req-123",
    });
  });

  it("submits Seedance 2 requests with fal schema fields", async () => {
    mockFalProviderRuntime();
    mockCompletedFalVideoJob({
      responseExtras: { seed: 42 },
    });

    const result = await generateVideo({
      model: "bytedance/seedance-2.0/fast/text-to-video",
      prompt: "A chrome lobster drives a tiny kart across a neon pier",
      durationSeconds: 7,
      aspectRatio: "16:9",
      resolution: "720P",
      audio: false,
    });

    expect(fetchGuardUrl(1)).toBe(
      "https://queue.fal.run/bytedance/seedance-2.0/fast/text-to-video",
    );
    expect(getSubmitBody()).toEqual({
      prompt: "A chrome lobster drives a tiny kart across a neon pier",
      aspect_ratio: "16:9",
      resolution: "720p",
      duration: "7",
      generate_audio: false,
    });
    expect(result.metadata).toEqual({
      requestId: "req-123",
      seed: 42,
    });
  });

  it("drops unsupported Seedance 2 duration values before queue submission", async () => {
    mockFalProviderRuntime();
    mockCompletedFalVideoJob();

    await generateVideo({
      model: "bytedance/seedance-2.0/fast/text-to-video",
      prompt: "A chrome lobster drives a tiny kart across a neon pier",
      durationSeconds: 99,
    });

    expect(getSubmitBody()).not.toHaveProperty("duration");
  });

  it("submits Seedance 2 image-to-video requests with a single image_url", async () => {
    mockFalProviderRuntime();
    mockCompletedFalVideoJob();

    await generateVideo({
      model: "bytedance/seedance-2.0/fast/image-to-video",
      prompt: "Animate this product still with a slow orbit",
      durationSeconds: 6,
      inputImages: [{ url: "https://example.com/start-frame.png" }],
    });

    expect(getSubmitBody()).toEqual({
      prompt: "Animate this product still with a slow orbit",
      image_url: "https://example.com/start-frame.png",
      duration: "6",
    });
  });

  it("submits Seedance 2 reference-to-video requests with image, video, and audio URLs", async () => {
    mockFalProviderRuntime();
    mockCompletedFalVideoJob({
      responseExtras: { seed: 1234 },
    });

    const result = await generateVideo({
      model: "bytedance/seedance-2.0/fast/reference-to-video",
      prompt: "Blend @Image1, @Image2, @Video1, @Video2, and @Audio1 into one short film",
      durationSeconds: 8,
      aspectRatio: "9:16",
      resolution: "480P",
      audio: false,
      inputImages: [
        { url: "https://example.com/reference-1.png" },
        { buffer: Buffer.from("local-image"), mimeType: "image/webp" },
      ],
      inputVideos: [
        { url: "https://example.com/reference-1.mp4" },
        { buffer: Buffer.from("local-video"), mimeType: "video/quicktime" },
      ],
      inputAudios: [
        { url: "https://example.com/reference-1.mp3" },
        { buffer: Buffer.from("local-audio"), mimeType: "audio/wav" },
      ],
    });

    expect(fetchGuardUrl(1)).toBe(
      "https://queue.fal.run/bytedance/seedance-2.0/fast/reference-to-video",
    );
    expect(getSubmitBody()).toEqual({
      prompt: "Blend @Image1, @Image2, @Video1, @Video2, and @Audio1 into one short film",
      image_urls: [
        "https://example.com/reference-1.png",
        `data:image/webp;base64,${Buffer.from("local-image").toString("base64")}`,
      ],
      video_urls: [
        "https://example.com/reference-1.mp4",
        `data:video/quicktime;base64,${Buffer.from("local-video").toString("base64")}`,
      ],
      audio_urls: [
        "https://example.com/reference-1.mp3",
        `data:audio/wav;base64,${Buffer.from("local-audio").toString("base64")}`,
      ],
      aspect_ratio: "9:16",
      resolution: "480p",
      duration: "8",
      generate_audio: false,
    });
    expect(result.metadata).toEqual({
      requestId: "req-123",
      seed: 1234,
    });
  });

  it("rejects video, audio, and multiple image references for non-reference fal models", async () => {
    await expect(
      generateVideo({
        inputImages: [
          { url: "https://example.com/one.png" },
          { url: "https://example.com/two.png" },
        ],
      }),
    ).rejects.toThrow("fal video generation supports at most one image reference.");

    await expect(
      generateVideo({
        inputVideos: [{ url: "https://example.com/reference.mp4" }],
      }),
    ).rejects.toThrow("fal video generation does not support video reference inputs.");

    await expect(
      generateVideo({
        inputAudios: [{ url: "https://example.com/reference.mp3" }],
      }),
    ).rejects.toThrow("fal video generation does not support audio reference inputs.");
  });

  it("rejects over-limit and audio-only Seedance reference-to-video requests", async () => {
    const model = "bytedance/seedance-2.0/fast/reference-to-video";

    await expect(
      generateVideo({
        model,
        prompt: "Too many images",
        inputImages: Array.from({ length: 10 }, (_, index) => ({
          url: `https://example.com/image-${index}.png`,
        })),
      }),
    ).rejects.toThrow("fal Seedance reference-to-video supports at most 9 reference images.");

    await expect(
      generateVideo({
        model,
        prompt: "Too many videos",
        inputVideos: Array.from({ length: 4 }, (_, index) => ({
          url: `https://example.com/video-${index}.mp4`,
        })),
      }),
    ).rejects.toThrow("fal Seedance reference-to-video supports at most 3 reference videos.");

    await expect(
      generateVideo({
        model,
        prompt: "Too many audios",
        inputAudios: Array.from({ length: 4 }, (_, index) => ({
          url: `https://example.com/audio-${index}.mp3`,
        })),
      }),
    ).rejects.toThrow("fal Seedance reference-to-video supports at most 3 reference audios.");

    await expect(
      generateVideo({
        model,
        prompt: "Too many total files",
        inputImages: Array.from({ length: 9 }, (_, index) => ({
          url: `https://example.com/image-${index}.png`,
        })),
        inputVideos: Array.from({ length: 3 }, (_, index) => ({
          url: `https://example.com/video-${index}.mp4`,
        })),
        inputAudios: [{ url: "https://example.com/audio.mp3" }],
      }),
    ).rejects.toThrow("fal Seedance reference-to-video supports at most 12 total reference files.");

    await expect(
      generateVideo({
        model,
        prompt: "Audio only",
        inputAudios: [{ url: "https://example.com/audio.mp3" }],
      }),
    ).rejects.toThrow(
      "fal Seedance reference-to-video requires at least one image or video reference when audio references are provided.",
    );
  });
});

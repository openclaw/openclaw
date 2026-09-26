// Venice tests cover video generation provider plugin behavior.
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setVeniceVideoFetchGuardForTesting } from "./test-support.js";
import { buildVeniceVideoGenerationProvider } from "./video-generation-provider.js";

const { fetchGuardMock, resolveApiKeyForProviderMock } = vi.hoisted(() => ({
  fetchGuardMock: vi.fn(),
  resolveApiKeyForProviderMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

const BASE_REQUEST = {
  provider: "venice",
  model: "wan-3-0-text-to-video",
  prompt: "a fox running through snow",
  cfg: {} as never,
};

function released(response: Response) {
  return { response, release: vi.fn(async () => {}) };
}

function releasedJson(value: unknown) {
  return released(Response.json(value));
}

function releasedVideo(bytes: string) {
  return released(
    new Response(Buffer.from(bytes), { status: 200, headers: { "content-type": "video/mp4" } }),
  );
}

function guardInit(index: number): RequestInit | undefined {
  return (fetchGuardMock.mock.calls[index]?.[0] as { init?: RequestInit } | undefined)?.init;
}

function requireInit(index: number): RequestInit {
  const init = guardInit(index);
  if (!init) {
    throw new Error(`expected venice fetch guard init ${index + 1}`);
  }
  return init;
}

function guardCall(index: number): { url: string; body: Record<string, unknown> } {
  const request = fetchGuardMock.mock.calls[index]?.[0] as
    | { url: string; init?: { body?: string } }
    | undefined;
  if (!request) {
    throw new Error(`expected venice fetch guard call ${index + 1}`);
  }
  return {
    url: request.url,
    body: request.init?.body ? (JSON.parse(request.init.body) as Record<string, unknown>) : {},
  };
}

describe("venice video generation provider", () => {
  function stubLiveVideoCatalog(rows: unknown[] = []) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: rows })),
    );
  }

  function liveVideoRow(id: string, constraints: Record<string, unknown>) {
    return { id, object: "model", type: "video", model_spec: { constraints } };
  }

  beforeEach(() => {
    stubLiveVideoCatalog();
    resolveApiKeyForProviderMock.mockResolvedValue({
      apiKey: "venice-test-key",
      source: "env",
      mode: "api-key",
    });
    setVeniceVideoFetchGuardForTesting(fetchGuardMock as never);
  });

  afterEach(() => {
    setVeniceVideoFetchGuardForTesting(null);
    fetchGuardMock.mockReset();
    resolveApiKeyForProviderMock.mockReset();
    clearLiveCatalogCacheForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("declares explicit mode capabilities", () => {
    const provider = buildVeniceVideoGenerationProvider();
    expectExplicitVideoGenerationCapabilities(provider);
    expect(provider.defaultModel).toBe("wan-3-0-text-to-video");
  });

  it("quotes, queues, polls, and returns the mp4 bytes from retrieve", async () => {
    fetchGuardMock
      .mockResolvedValueOnce(releasedJson({ quote: 0.42 }))
      .mockResolvedValueOnce(releasedJson({ model: "wan-3-0-text-to-video", queue_id: "q-1" }))
      .mockResolvedValueOnce(
        releasedJson({ status: "PROCESSING", average_execution_time: 1, execution_duration: 1 }),
      )
      .mockResolvedValueOnce(releasedVideo("mp4-bytes"))
      .mockResolvedValueOnce(releasedJson({ success: true }));
    vi.useFakeTimers();
    const provider = buildVeniceVideoGenerationProvider();
    const pending = provider.generateVideo({
      ...BASE_REQUEST,
      durationSeconds: 8,
      aspectRatio: "16:9",
      resolution: "720P",
      audio: false,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    expect(guardCall(0).url).toBe("https://api.venice.ai/api/v1/video/quote");
    expect(guardCall(0).body).toEqual({
      model: "wan-3-0-text-to-video",
      duration: "8s",
      aspect_ratio: "16:9",
      resolution: "720p",
      audio: false,
    });
    expect(guardCall(1).url).toBe("https://api.venice.ai/api/v1/video/queue");
    expect(guardCall(1).body).toMatchObject({
      model: "wan-3-0-text-to-video",
      prompt: "a fox running through snow",
      duration: "8s",
      resolution: "720p",
    });
    expect(guardCall(2).url).toBe("https://api.venice.ai/api/v1/video/retrieve");
    expect(guardCall(2).body).toEqual({ model: "wan-3-0-text-to-video", queue_id: "q-1" });
    // Cleanup happens only after the bytes were read successfully.
    expect(guardCall(4).url).toBe("https://api.venice.ai/api/v1/video/complete");
    expect(fetchGuardMock).toHaveBeenCalledTimes(5);
    expect(result.model).toBe("wan-3-0-text-to-video");
    expect(result.metadata).toEqual({ queueId: "q-1", quoteUsd: 0.42 });
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    expect(result.videos[0]?.fileName).toBe("video-1.mp4");
    expect(result.videos[0]?.buffer?.toString()).toBe("mp4-bytes");
  });

  it("downloads private-model output from the queue-time download_url", async () => {
    fetchGuardMock
      .mockResolvedValueOnce(released(new Response("nope", { status: 400 })))
      .mockResolvedValueOnce(
        releasedJson({ queue_id: "q-2", download_url: "https://files.venice.ai/q-2.mp4" }),
      )
      .mockResolvedValueOnce(releasedJson({ status: "COMPLETED" }))
      .mockResolvedValueOnce(releasedVideo("private-bytes"))
      .mockResolvedValueOnce(released(new Response(null, { status: 204 })))
      .mockResolvedValueOnce(releasedJson({ success: true }));
    const provider = buildVeniceVideoGenerationProvider();
    const result = await provider.generateVideo(BASE_REQUEST);

    // Media must survive until the download succeeds, then the presigned URL
    // is revoked and the queue entry cleaned up.
    expect(guardCall(2).body).toEqual({ model: "wan-3-0-text-to-video", queue_id: "q-2" });
    expect(guardCall(3).url).toBe("https://files.venice.ai/q-2.mp4");
    expect(guardCall(4).url).toBe("https://files.venice.ai/q-2.mp4");
    expect(requireInit(4).method).toBe("DELETE");
    // The presigned delivery origin never receives the API bearer token.
    expect(guardInit(3)?.headers).toBeUndefined();
    expect(guardInit(4)?.headers).toBeUndefined();
    expect(guardCall(5).url).toBe("https://api.venice.ai/api/v1/video/complete");
    expect(guardCall(5).body).toEqual({ model: "wan-3-0-text-to-video", queue_id: "q-2" });
    expect(fetchGuardMock).toHaveBeenCalledTimes(6);
    expect(result.metadata).toEqual({ queueId: "q-2" });
    expect(result.videos[0]?.buffer?.toString()).toBe("private-bytes");
  });

  it("still cleans up the queue entry when revoking the private download link fails", async () => {
    fetchGuardMock
      .mockResolvedValueOnce(releasedJson({ quote: 0.1 }))
      .mockResolvedValueOnce(
        releasedJson({ queue_id: "q-11", download_url: "https://files.venice.ai/q-11.mp4" }),
      )
      .mockResolvedValueOnce(releasedJson({ status: "COMPLETED" }))
      .mockResolvedValueOnce(releasedVideo("private-bytes"))
      .mockResolvedValueOnce(released(new Response("gone", { status: 410 })))
      .mockResolvedValueOnce(releasedJson({ success: true }));
    const provider = buildVeniceVideoGenerationProvider();
    const result = await provider.generateVideo(BASE_REQUEST);
    expect(guardCall(5).url).toBe("https://api.venice.ai/api/v1/video/complete");
    expect(result.videos[0]?.buffer?.toString()).toBe("private-bytes");
  });

  it("keeps an oversized private download link live instead of revoking it", async () => {
    fetchGuardMock
      .mockResolvedValueOnce(releasedJson({ quote: 0.1 }))
      .mockResolvedValueOnce(
        releasedJson({ queue_id: "q-12", download_url: "https://files.venice.ai/q-12.mp4" }),
      )
      .mockResolvedValueOnce(releasedJson({ status: "COMPLETED" }))
      .mockResolvedValueOnce(releasedVideo("far too many bytes for a one-byte cap"));
    const provider = buildVeniceVideoGenerationProvider();
    const result = await provider.generateVideo({
      ...BASE_REQUEST,
      cfg: { agents: { defaults: { mediaMaxMb: 1 / (1024 * 1024) } } } as never,
    });
    expect(result.videos[0]).toMatchObject({ url: "https://files.venice.ai/q-12.mp4" });
    expect(result.videos[0]?.buffer).toBeUndefined();
    expect(fetchGuardMock).toHaveBeenCalledTimes(4);
  });

  it("fills the required aspect ratio and the cheapest resolution from live constraints", async () => {
    stubLiveVideoCatalog([
      liveVideoRow("wan-3-0-text-to-video", {
        model_type: "text-to-video",
        aspect_ratios: ["16:9", "9:16", "1:1"],
        resolutions: ["1080p", "720p", "480p"],
        durations: ["2s", "5s"],
        audio_configurable: true,
        audio_input: false,
        video_input: false,
      }),
    ]);
    fetchGuardMock
      .mockResolvedValueOnce(releasedJson({ quote: 0.1 }))
      .mockResolvedValueOnce(releasedJson({ queue_id: "q-defaults" }))
      .mockResolvedValueOnce(releasedVideo("bytes"))
      .mockResolvedValueOnce(releasedJson({ success: true }));
    const provider = buildVeniceVideoGenerationProvider();
    await provider.generateVideo({ ...BASE_REQUEST, durationSeconds: 2 });
    expect(guardCall(1).body).toMatchObject({ aspect_ratio: "16:9", resolution: "480p" });
  });

  it("names the rejected field from Venice's 400 issues list", async () => {
    fetchGuardMock.mockResolvedValueOnce(releasedJson({ quote: 0.1 })).mockResolvedValueOnce(
      released(
        new Response(
          JSON.stringify({
            error: "Invalid request parameters",
            issues: [{ path: ["aspect_ratio"], message: "Required" }],
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const provider = buildVeniceVideoGenerationProvider();
    await expect(provider.generateVideo(BASE_REQUEST)).rejects.toThrow(/aspect_ratio: Required/);
  });

  it("skips the quote for jobs with video inputs instead of reporting the no-reference tier", async () => {
    fetchGuardMock
      .mockResolvedValueOnce(releasedJson({ queue_id: "q-9" }))
      .mockResolvedValueOnce(releasedVideo("bytes"))
      .mockResolvedValueOnce(releasedJson({ success: true }));
    const provider = buildVeniceVideoGenerationProvider();
    const result = await provider.generateVideo({
      ...BASE_REQUEST,
      model: "wan-3-0-reference-to-video",
      inputVideos: [{ url: "https://example.com/motion.mp4", role: "reference_video" }],
    });
    expect(guardCall(0).url).toBe("https://api.venice.ai/api/v1/video/queue");
    expect(result.metadata).toEqual({ queueId: "q-9" });
  });

  it("switches the default text model to its image-to-video sibling when an image is attached", async () => {
    fetchGuardMock
      .mockResolvedValueOnce(releasedJson({ quote: 0.1 }))
      .mockResolvedValueOnce(releasedJson({ queue_id: "q-3" }))
      .mockResolvedValueOnce(releasedVideo("bytes"))
      .mockResolvedValueOnce(releasedJson({ success: true }));
    const provider = buildVeniceVideoGenerationProvider();
    const result = await provider.generateVideo({
      ...BASE_REQUEST,
      inputImages: [{ buffer: Buffer.from("png"), mimeType: "image/png" }],
    });

    expect(guardCall(1).body).toMatchObject({
      model: "wan-3-0-image-to-video",
      image_url: `data:image/png;base64,${Buffer.from("png").toString("base64")}`,
    });
    expect(result.model).toBe("wan-3-0-image-to-video");
  });

  it("maps reference roles onto Venice's input fields", async () => {
    stubLiveVideoCatalog([
      liveVideoRow("wan-3-0-reference-to-video", {
        model_type: "image-to-video",
        aspect_ratios: [],
        resolutions: [],
        durations: ["5s"],
        audio_configurable: true,
        audio_input: true,
        video_input: true,
      }),
    ]);
    fetchGuardMock
      .mockResolvedValueOnce(releasedJson({ queue_id: "q-roles" }))
      .mockResolvedValueOnce(releasedVideo("bytes"))
      .mockResolvedValueOnce(releasedJson({ success: true }));
    const provider = buildVeniceVideoGenerationProvider();
    await provider.generateVideo({
      ...BASE_REQUEST,
      model: "wan-3-0-reference-to-video",
      inputImages: [
        { url: "https://example.com/first.png", role: "first_frame" },
        { url: "https://example.com/last.png", role: "last_frame" },
        { url: "https://example.com/ref-a.png", role: "reference_image" },
        { url: "https://example.com/ref-b.png", role: "reference_image" },
      ],
      inputVideos: [{ url: "https://example.com/motion.mp4", role: "reference_video" }],
      inputAudios: [{ url: "https://example.com/music.mp3" }],
    });

    // Video inputs skip the quote, so the queue call comes first.
    expect(guardCall(0).url).toBe("https://api.venice.ai/api/v1/video/queue");
    expect(guardCall(0).body).toEqual({
      model: "wan-3-0-reference-to-video",
      prompt: "a fox running through snow",
      duration: "5s",
      image_url: "https://example.com/first.png",
      end_image_url: "https://example.com/last.png",
      reference_image_urls: ["https://example.com/ref-a.png", "https://example.com/ref-b.png"],
      reference_video_urls: ["https://example.com/motion.mp4"],
      audio_url: "https://example.com/music.mp3",
    });
  });

  it("rejects malformed queue and status payloads without waiting for the timeout", async () => {
    fetchGuardMock
      .mockResolvedValueOnce(releasedJson({ quote: 0.1 }))
      .mockResolvedValueOnce(releasedJson({ model: "x" }));
    const provider = buildVeniceVideoGenerationProvider();
    await expect(provider.generateVideo(BASE_REQUEST)).rejects.toThrow(/malformed/);

    fetchGuardMock.mockReset();
    fetchGuardMock
      .mockResolvedValueOnce(releasedJson({ quote: 0.1 }))
      .mockResolvedValueOnce(releasedJson({ queue_id: "q-4" }))
      .mockResolvedValueOnce(releasedJson({ id: "no-status" }));
    await expect(provider.generateVideo(BASE_REQUEST)).rejects.toThrow(/malformed/);
  });

  it("surfaces provider-signaled terminal statuses with their detail", async () => {
    fetchGuardMock
      .mockResolvedValueOnce(releasedJson({ quote: 0.1 }))
      .mockResolvedValueOnce(releasedJson({ queue_id: "q-4" }))
      .mockResolvedValueOnce(releasedJson({ status: "FAILED", error: "content policy" }));
    const provider = buildVeniceVideoGenerationProvider();
    await expect(provider.generateVideo(BASE_REQUEST)).rejects.toThrow(
      "venice video generation failed: content policy",
    );
  });

  it("treats quote transport failures and bad quote bodies as no quote", async () => {
    fetchGuardMock
      .mockRejectedValueOnce(new Error("quote host unreachable"))
      .mockResolvedValueOnce(releasedJson({ queue_id: "q-6" }))
      .mockResolvedValueOnce(releasedVideo("bytes"))
      .mockResolvedValueOnce(releasedJson({ success: true }));
    const provider = buildVeniceVideoGenerationProvider();
    const result = await provider.generateVideo(BASE_REQUEST);
    expect(result.metadata).toEqual({ queueId: "q-6" });

    fetchGuardMock.mockReset();
    fetchGuardMock
      .mockResolvedValueOnce(released(new Response("<html>", { status: 200 })))
      .mockResolvedValueOnce(releasedJson({ queue_id: "q-7" }))
      .mockResolvedValueOnce(releasedVideo("bytes"))
      .mockResolvedValueOnce(releasedJson({ success: true }));
    expect((await provider.generateVideo(BASE_REQUEST)).metadata).toEqual({ queueId: "q-7" });
  });

  it("never retries the billed queue submission on a transient failure", async () => {
    fetchGuardMock
      .mockResolvedValueOnce(releasedJson({ quote: 0.1 }))
      .mockResolvedValueOnce(released(new Response("<html>502</html>", { status: 502 })));
    const provider = buildVeniceVideoGenerationProvider();
    await expect(provider.generateVideo(BASE_REQUEST)).rejects.toThrow(/502/);
    expect(fetchGuardMock).toHaveBeenCalledTimes(2);
  });

  it("retries a transient retrieve failure instead of dropping the queued job", async () => {
    fetchGuardMock
      .mockResolvedValueOnce(releasedJson({ quote: 0.1 }))
      .mockResolvedValueOnce(releasedJson({ queue_id: "q-8" }))
      .mockResolvedValueOnce(released(new Response("<html>502</html>", { status: 502 })))
      .mockResolvedValueOnce(releasedVideo("bytes-after-retry"))
      .mockResolvedValueOnce(releasedJson({ success: true }));
    const provider = buildVeniceVideoGenerationProvider();
    const result = await provider.generateVideo(BASE_REQUEST);
    expect(fetchGuardMock).toHaveBeenCalledTimes(5);
    expect(guardCall(3).url).toBe("https://api.venice.ai/api/v1/video/retrieve");
    expect(result.videos[0]?.buffer?.toString()).toBe("bytes-after-retry");
  });

  it("stops polling when the operation deadline is exhausted", async () => {
    fetchGuardMock
      .mockResolvedValueOnce(releasedJson({ quote: 0.1 }))
      .mockResolvedValueOnce(releasedJson({ queue_id: "q-5" }))
      .mockImplementation(async () => releasedJson({ status: "PROCESSING" }));
    vi.useFakeTimers();
    const provider = buildVeniceVideoGenerationProvider();
    const pending = provider.generateVideo({ ...BASE_REQUEST, timeoutMs: 7_000 });
    const rejection = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(12_000);
    await rejection;
  });

  it("derives per-model capabilities from live Venice video constraints", async () => {
    stubLiveVideoCatalog([
      liveVideoRow("seedance-2-0-image-to-video-basic", {
        model_type: "image-to-video",
        aspect_ratios: [],
        resolutions: ["4k", "1080p", "720p"],
        durations: ["4s", "5s", "Auto", "10s"],
        audio: true,
        audio_configurable: true,
        audio_input: true,
        video_input: false,
      }),
      liveVideoRow("wan-3-0-text-to-video", {
        model_type: "text-to-video",
        aspect_ratios: ["16:9"],
        resolutions: ["720p"],
        durations: ["5s"],
        audio_configurable: true,
        audio_input: false,
        video_input: false,
      }),
      liveVideoRow("wan-3-0-image-to-video", {
        model_type: "image-to-video",
        aspect_ratios: ["9:16"],
        resolutions: ["1080p"],
        durations: ["5s", "10s"],
        audio_configurable: false,
        audio_input: false,
        video_input: false,
      }),
    ]);
    try {
      const provider = buildVeniceVideoGenerationProvider();
      const capabilities = await provider.resolveModelCapabilities?.({
        provider: "venice",
        model: "seedance-2-0-image-to-video-basic",
        cfg: {} as never,
      });
      expect(capabilities?.imageToVideo).toMatchObject({
        enabled: true,
        maxInputImages: 2,
        maxInputAudios: 10,
        supportedDurationSeconds: [4, 5, 10],
        maxDurationSeconds: 10,
        resolutions: ["4K", "1080P", "720P"],
        supportsAspectRatio: false,
        supportsResolution: true,
        supportsAudio: true,
      });
      expect(capabilities?.videoToVideo).toMatchObject({ enabled: false, maxInputVideos: 0 });

      // The text default advertises its image sibling's image mode so core lets
      // image requests through to the model swap.
      const textDefault = await provider.resolveModelCapabilities?.({
        provider: "venice",
        model: "wan-3-0-text-to-video",
        cfg: {} as never,
      });
      expect(textDefault?.generate).toMatchObject({ aspectRatios: ["16:9"], supportsAudio: true });
      expect(textDefault?.imageToVideo).toMatchObject({
        enabled: true,
        maxInputImages: 2,
        aspectRatios: ["9:16"],
        supportedDurationSeconds: [5, 10],
        supportsAudio: false,
      });
      expect(
        await provider.resolveModelCapabilities?.({
          provider: "venice",
          model: "not-a-venice-model",
          cfg: {} as never,
        }),
      ).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects text-only requests against image-only models before queueing", async () => {
    stubLiveVideoCatalog([
      liveVideoRow("kling-v3-pro-image-to-video", {
        model_type: "image-to-video",
        aspect_ratios: [],
        resolutions: [],
        durations: ["5s"],
        audio_configurable: false,
        audio_input: false,
        video_input: false,
      }),
    ]);
    const provider = buildVeniceVideoGenerationProvider();
    await expect(
      provider.generateVideo({ ...BASE_REQUEST, model: "kling-v3-pro-image-to-video" }),
    ).rejects.toThrow("requires an image input");
    expect(fetchGuardMock).not.toHaveBeenCalled();
  });

  it("accepts video-only references on reference models that take video input", async () => {
    stubLiveVideoCatalog([
      liveVideoRow("wan-3-0-reference-to-video", {
        model_type: "image-to-video",
        aspect_ratios: [],
        resolutions: [],
        durations: ["5s"],
        audio_configurable: false,
        audio_input: false,
        video_input: true,
      }),
    ]);
    fetchGuardMock
      .mockResolvedValueOnce(releasedJson({ queue_id: "q-10" }))
      .mockResolvedValueOnce(releasedVideo("bytes"))
      .mockResolvedValueOnce(releasedJson({ success: true }));
    const provider = buildVeniceVideoGenerationProvider();
    const result = await provider.generateVideo({
      ...BASE_REQUEST,
      model: "wan-3-0-reference-to-video",
      inputVideos: [{ url: "https://example.com/motion.mp4", role: "reference_video" }],
    });
    expect(guardCall(0).url).toBe("https://api.venice.ai/api/v1/video/queue");
    expect(result.metadata).toEqual({ queueId: "q-10" });
  });

  it("marks text-to-video constraints as generate-only and video_input as video-to-video", async () => {
    stubLiveVideoCatalog([
      liveVideoRow("wan-3-0-text-to-video", {
        model_type: "text-to-video",
        aspect_ratios: ["16:9"],
        resolutions: ["720p"],
        durations: ["5s", "10s"],
        audio_configurable: false,
        audio_input: false,
        video_input: false,
      }),
      liveVideoRow("gemini-omni-flash-1-1-video-to-video", {
        model_type: "video",
        aspect_ratios: [],
        resolutions: [],
        durations: ["Auto"],
        audio_configurable: false,
        audio_input: false,
        video_input: true,
      }),
      liveVideoRow("wan-3-0-reference-to-video", {
        model_type: "image-to-video",
        aspect_ratios: [],
        resolutions: [],
        durations: ["5s"],
        audio_configurable: true,
        audio_input: true,
        video_input: true,
      }),
    ]);
    const provider = buildVeniceVideoGenerationProvider();
    const resolve = (model: string) =>
      provider.resolveModelCapabilities?.({ provider: "venice", model, cfg: {} as never });

    const textOnly = await resolve("wan-3-0-text-to-video");
    // The text default advertises its image sibling; the sibling row is absent
    // here, so the text row's own (disabled) image mode stands.
    expect(textOnly?.imageToVideo).toMatchObject({ enabled: false, maxInputImages: 0 });
    expect(textOnly?.generate?.aspectRatios).toEqual(["16:9"]);

    const edit = await resolve("gemini-omni-flash-1-1-video-to-video");
    expect(edit?.imageToVideo?.enabled).toBe(false);
    expect(edit?.videoToVideo).toMatchObject({
      enabled: true,
      maxInputVideos: 1,
      maxInputImages: 0,
    });
    expect(edit?.generate?.supportedDurationSeconds).toBeUndefined();

    const reference = await resolve("wan-3-0-reference-to-video");
    expect(reference?.imageToVideo).toMatchObject({ enabled: true, maxInputImages: 30 });
    expect(reference?.videoToVideo).toMatchObject({
      enabled: true,
      maxInputVideos: 10,
      maxInputImages: 30,
      maxInputAudios: 10,
    });
  });
});

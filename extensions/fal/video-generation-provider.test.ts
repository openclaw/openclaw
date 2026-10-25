import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { generateVideo as generateRuntimeVideo } from "openclaw/plugin-sdk/video-generation-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFalVideoGenerationProvider } from "./video-generation-provider.js";

const { fetchGuardMock } = vi.hoisted(() => ({ fetchGuardMock: vi.fn() }));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchGuardMock,
}));

const queueSubmission = {
  request_id: "req-123",
  status_url: "https://queue.fal.run/fal-ai/minimax/requests/req-123/status",
  response_url: "https://queue.fal.run/fal-ai/minimax/requests/req-123",
};
const videoUrl = "https://fal.run/files/video.mp4";
const referenceModel = "bytedance/seedance-2.0/fast/reference-to-video";
const mediaCap = { agents: { defaults: { mediaMaxMb: 0.000001 } } };
const references = (kind: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({ url: `https://example.com/${kind}-${index}` }));
const dataUrl = (kind: string, mimeType: string) =>
  `data:${mimeType};base64,${Buffer.from(`local-${kind}`).toString("base64")}`;
const mixedReferences = (url: string, kind: string, mimeType: string) => [
  { url },
  { buffer: Buffer.from(`local-${kind}`), mimeType },
];

function generateVideo(request: Partial<VideoGenerationRequest> = {}) {
  return buildFalVideoGenerationProvider().generateVideo({
    provider: "fal",
    model: "fal-ai/minimax/video-01-live",
    prompt: "Animate this",
    cfg: {},
    ...request,
  });
}

async function expectRejected(request: Partial<VideoGenerationRequest>, message: string) {
  await expect(generateVideo(request)).rejects.toThrow(message);
}

describe("fal video generation provider", () => {
  it("rejects a duration that rounds to zero before submission", async () => {
    mockFalProviderRuntime();
    await expect(
      generateVideo({ model: "bytedance/seedance-2.0/fast/text-to-video", durationSeconds: 0.4 }),
    ).rejects.toThrow("durationSeconds must be a positive duration");
    expect(fetchGuardMock).not.toHaveBeenCalled();
  });

  it.each([
    { model: "fal-ai/minimax/video-01-live", ignored: ["aspectRatio", "resolution", "audio"] },
    { model: "fal-ai/heygen/v2/video-agent", ignored: ["aspectRatio", "resolution", "audio"] },
    { model: "fal-ai/kling-video/v2.1/master/text-to-video", ignored: ["audio"] },
    { model: "fal-ai/wan/v2.2-a14b/text-to-video", ignored: ["audio"] },
    { model: "bytedance/seedance-2.0/text-to-video", ignored: [] },
  ])("reports ignored overrides through the runtime for $model", async ({ model, ignored }) => {
    mockCompletedFalVideoJob();
    const provider = buildFalVideoGenerationProvider();
    const result = await generateRuntimeVideo(
      {
        cfg: { agents: { defaults: { mediaModels: { video: `fal/${model}` } } } },
        prompt: "Animate this",
        aspectRatio: "16:9",
        resolution: "1080P",
        audio: true,
      },
      {
        getProvider: (id) => (id === provider.id ? provider : undefined),
        listProviders: () => [provider],
        getProviderEnvVars: () => [],
        log: { debug: vi.fn(), warn: vi.fn() },
      },
    );
    expect(result.ignoredOverrides.map((override) => override.key)).toEqual(ignored);
    const body = getSubmitBody();
    if (ignored.includes("aspectRatio")) {
      expect(body).toEqual({ prompt: "Animate this" });
    } else {
      expect(body).toMatchObject({ aspect_ratio: "16:9" });
      if (ignored.includes("audio")) {
        expect(body).not.toHaveProperty("generate_audio");
      } else {
        expect(body).toMatchObject({ resolution: "1080p", generate_audio: true });
      }
    }
  });

  function mockFalProviderRuntime() {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-key",
      source: "env",
      mode: "api-key",
    });
  }

  function releasedJson(value: unknown) {
    return { response: Response.json(value), release: vi.fn(async () => {}) };
  }

  function releasedVideo(contentType = "video/mp4", bytes = "mp4-bytes") {
    return {
      response: new Response(Buffer.from(bytes), {
        headers: { "content-type": contentType },
      }),
      release: vi.fn(async () => {}),
    };
  }

  function mockQueueResult(payload: unknown) {
    mockFalProviderRuntime();
    fetchGuardMock
      .mockResolvedValueOnce(releasedJson(queueSubmission))
      .mockResolvedValueOnce(releasedJson({ status: "COMPLETED" }))
      .mockResolvedValueOnce(releasedJson(payload));
  }

  function mockCompletedFalVideoJob(
    download = releasedVideo(),
    responseExtras: Record<string, unknown> = {},
  ) {
    mockQueueResult({
      status: "COMPLETED",
      response: { video: { url: videoUrl }, ...responseExtras },
    });
    fetchGuardMock.mockResolvedValueOnce(download);
  }

  function requireFetchGuardCall(callNumber: number): { init?: RequestInit; url?: string } {
    const request = fetchGuardMock.mock.calls[callNumber - 1]?.[0];
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

  afterEach(() => {
    vi.restoreAllMocks();
    fetchGuardMock.mockReset();
  });

  it("parses raw fal queue result payloads with top-level video output", async () => {
    const prompt = "A calm harbor at sunrise";
    mockQueueResult({
      video: { url: "https://fal.run/files/raw-output.mp4" },
      prompt,
      seed: 443600358,
    });
    fetchGuardMock.mockResolvedValueOnce(releasedVideo());

    const result = await generateVideo({
      model: "fal-ai/wan/v2.2-a14b/image-to-video",
      prompt,
    });

    expect(result.videos[0]?.url).toBe("https://fal.run/files/raw-output.mp4");
    expect(result.metadata).toEqual({ requestId: "req-123", prompt, seed: 443600358 });
  });

  it("returns URL-only videos when generated video downloads exceed the configured media cap", async () => {
    mockCompletedFalVideoJob(releasedVideo("video/mp4", "too-large"));

    const result = await generateVideo({
      prompt: "A spaceship emerges from the clouds",
      durationSeconds: 5,
      aspectRatio: "16:9",
      resolution: "720P",
      cfg: mediaCap,
    });

    expect(requireFetchGuardCall(1).url).toBe("https://queue.fal.run/fal-ai/minimax/video-01-live");
    expect(getSubmitBody()).toEqual({ prompt: "A spaceship emerges from the clouds" });
    expect(result.videos).toEqual([
      { url: videoUrl, mimeType: "video/mp4", fileName: "video-1.mp4" },
    ]);
  });

  it("rejects malformed generated video downloads instead of returning URL-only videos", async () => {
    mockCompletedFalVideoJob(releasedVideo("application/json", '{"error":"denied"}'));

    await expectRejected(
      { cfg: mediaCap },
      "fal generated video download: malformed video response",
    );
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

  it.each([{}, { status: "ALMOST_DONE" }])("rejects status %j immediately", async (response) => {
    mockFalProviderRuntime();
    fetchGuardMock
      .mockResolvedValueOnce(releasedJson(queueSubmission))
      .mockResolvedValueOnce(releasedJson(response));

    await expect(generateVideo()).rejects.toThrow("fal video generation response malformed");
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

    await expectRejected(
      { timeoutMs: Number.MAX_SAFE_INTEGER },
      "fal video generation did not finish in time (last status: IN_PROGRESS)",
    );
    expect(fetchGuardMock).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed fal completed result payloads", async () => {
    mockQueueResult({ status: "COMPLETED", response: [] });

    await expect(generateVideo()).rejects.toThrow("fal video generation response malformed");
  });

  it("drops unsupported Seedance 2 duration values before queue submission", async () => {
    mockCompletedFalVideoJob();

    await generateVideo({
      model: "bytedance/seedance-2.0/fast/text-to-video",
      prompt: "A chrome lobster drives a tiny kart across a neon pier",
      durationSeconds: 99,
    });

    expect(getSubmitBody()).not.toHaveProperty("duration");
  });

  it.each([
    {
      input: { url: "https://example.com/start-frame.png" },
      url: "https://example.com/start-frame.png",
    },
    {
      input: { buffer: Buffer.from("image"), mimeType: " \t" },
      url: "data:image/png;base64,aW1hZ2U=",
    },
  ])(
    "submits Seedance 2 image-to-video requests with a single image_url $url",
    async ({ input, url }) => {
      mockCompletedFalVideoJob();

      await generateVideo({
        model: "bytedance/seedance-2.0/fast/image-to-video",
        prompt: "Animate this product still with a slow orbit",
        durationSeconds: 6,
        inputImages: [input],
      });

      expect(getSubmitBody()).toEqual({
        prompt: "Animate this product still with a slow orbit",
        image_url: url,
        duration: "6",
      });
    },
  );

  it("submits Seedance 2 reference-to-video requests with image, video, and audio URLs", async () => {
    mockCompletedFalVideoJob(releasedVideo(), { seed: 1234 });

    const result = await generateVideo({
      model: referenceModel,
      prompt: "Blend @Image1, @Image2, @Video1, @Video2, and @Audio1 into one short film",
      durationSeconds: 8,
      aspectRatio: "9:16",
      resolution: "480P",
      audio: false,
      inputImages: [
        ...mixedReferences("https://example.com/reference-1.png", "image", "image/webp"),
        { buffer: Buffer.from("image") },
      ],
      inputVideos: [
        ...mixedReferences("https://example.com/reference-1.mp4", "video", "video/quicktime"),
        { buffer: Buffer.from("video"), mimeType: " " },
      ],
      inputAudios: [
        ...mixedReferences("https://example.com/reference-1.mp3", "audio", "audio/wav"),
        { buffer: Buffer.from("audio") },
      ],
    });

    expect(requireFetchGuardCall(1).url).toBe(`https://queue.fal.run/${referenceModel}`);
    expect(getSubmitBody()).toEqual({
      prompt: "Blend @Image1, @Image2, @Video1, @Video2, and @Audio1 into one short film",
      image_urls: [
        "https://example.com/reference-1.png",
        dataUrl("image", "image/webp"),
        "data:image/png;base64,aW1hZ2U=",
      ],
      video_urls: [
        "https://example.com/reference-1.mp4",
        dataUrl("video", "video/quicktime"),
        "data:video/mp4;base64,dmlkZW8=",
      ],
      audio_urls: [
        "https://example.com/reference-1.mp3",
        dataUrl("audio", "audio/wav"),
        "data:audio/mpeg;base64,YXVkaW8=",
      ],
      aspect_ratio: "9:16",
      resolution: "480p",
      duration: "8",
      generate_audio: false,
    });
    expect(result.metadata).toEqual({ requestId: "req-123", seed: 1234 });
  });

  it("rejects video, audio, and multiple image references for non-reference fal models", async () => {
    await expectRejected(
      { inputImages: references("image", 2) },
      "fal video generation supports at most one image reference.",
    );
    await expectRejected(
      { inputVideos: references("video", 1) },
      "fal video generation does not support video reference inputs.",
    );
    await expectRejected(
      { inputAudios: references("audio", 1) },
      "fal video generation does not support audio reference inputs.",
    );
  });

  it("rejects over-limit and audio-only Seedance reference-to-video requests", async () => {
    const model = referenceModel;
    await expectRejected(
      { model, inputImages: references("image", 10) },
      "fal Seedance reference-to-video supports at most 9 reference images.",
    );
    await expectRejected(
      { model, inputVideos: references("video", 4) },
      "fal Seedance reference-to-video supports at most 3 reference videos.",
    );
    await expectRejected(
      { model, inputAudios: references("audio", 4) },
      "fal Seedance reference-to-video supports at most 3 reference audios.",
    );
    await expectRejected(
      {
        model,
        inputImages: references("image", 9),
        inputVideos: references("video", 3),
        inputAudios: references("audio", 1),
      },
      "fal Seedance reference-to-video supports at most 12 total reference files.",
    );
    await expectRejected(
      { model, inputAudios: references("audio", 1) },
      "fal Seedance reference-to-video requires at least one image or video reference when audio references are provided.",
    );
  });
});

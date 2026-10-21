import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  oversizedJsonResponse,
  streamedJsonResponse,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import type {
  VideoGenerationRequest,
  VideoGenerationSourceAsset,
} from "openclaw/plugin-sdk/video-generation";
import { beforeAll, describe, expect, it, vi } from "vitest";

const {
  postJsonRequestMock,
  fetchWithTimeoutGuardedMock,
  fetchWithTimeoutMock,
  resolveApiKeyForProviderMock,
  resolveProviderHttpRequestConfigMock,
  sanitizeConfiguredModelProviderRequestMock,
} = getProviderHttpMocks();

let buildXaiVideoGenerationProvider: typeof import("./video-generation-provider.js").buildXaiVideoGenerationProvider;

beforeAll(async () => {
  ({ buildXaiVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

type PostJsonCall = {
  url?: string;
  body?: Record<string, unknown>;
  headers?: Headers;
  allowPrivateNetwork?: boolean;
  dispatcherPolicy?: unknown;
};

function requirePostJsonCall(index = 0): PostJsonCall {
  const params = (postJsonRequestMock.mock.calls as unknown as Array<[PostJsonCall]>)[index]?.[0];
  if (!params) {
    throw new Error(`Expected postJsonRequest call ${index}`);
  }
  return params;
}

function mockSubmit(response: Response) {
  postJsonRequestMock.mockImplementation(async () => ({
    response,
    release: vi.fn(async () => {}),
  }));
}

function mockXaiVideoRequest(requestId = "req") {
  mockSubmit(Response.json({ request_id: requestId }));
}

function mockPoll(payload: Record<string, unknown>) {
  fetchWithTimeoutMock.mockResolvedValueOnce(Response.json({ request_id: "req", ...payload }));
}

function asset(
  name: string,
  role?: VideoGenerationSourceAsset["role"],
): VideoGenerationSourceAsset {
  return { url: `https://example.com/${name}`, ...(role ? { role } : {}) };
}

const models15 = [
  "grok-imagine-video-1.5",
  "grok-imagine-video-1.5-preview",
  "grok-imagine-video-1.5-2026-05-30",
];

function mockXaiVideoTask(requestId = "req") {
  mockXaiVideoRequest(requestId);
  mockPoll({ request_id: requestId, status: "done", video: { url: "https://cdn.x.ai/video.mp4" } });
  fetchWithTimeoutMock.mockResolvedValueOnce({
    headers: new Headers({ "content-type": "video/mp4" }),
    arrayBuffer: async () => Buffer.from("video-bytes"),
  });
}

function generate(overrides: Partial<VideoGenerationRequest> = {}) {
  return buildXaiVideoGenerationProvider().generateVideo({
    provider: "xai",
    model: "grok-imagine-video",
    prompt: "a lobster",
    cfg: {},
    ...overrides,
  });
}

describe("xai video generation provider", () => {
  it("rejects a duration that rounds to zero before submission", async () => {
    await expect(generate({ durationSeconds: 0.4 })).rejects.toThrow(
      "durationSeconds must be a positive duration",
    );
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("advertises canonical 1.5 and resolves capabilities for all API aliases", async () => {
    const provider = buildXaiVideoGenerationProvider();
    const capabilities15 = {
      imageToVideo: {
        enabled: true,
        maxInputImages: 1,
        maxDurationSeconds: 15,
        resolutions: ["480P", "720P", "1080P"],
      },
      videoToVideo: { enabled: false },
    };

    expect(provider).toMatchObject({
      defaultModel: "grok-imagine-video",
      models: ["grok-imagine-video", "grok-imagine-video-1.5"],
    });
    expect(provider.catalogByModel?.["grok-imagine-video-1.5"]).toMatchObject({
      modes: ["imageToVideo"],
      capabilities: capabilities15,
    });

    for (const model of models15) {
      const capabilities = await provider.resolveModelCapabilities?.({
        provider: "xai",
        model,
        cfg: {},
      });
      expect(capabilities).toMatchObject(capabilities15);
    }
  });

  it("uses the 1.5 default while preserving aliases, 1080p, and source aspect ratio", async () => {
    for (const [index, model] of models15.entries()) {
      mockXaiVideoTask(`req_15_${index}`);

      const result = await generate({
        model,
        durationSeconds: 20,
        resolution: index === 0 ? undefined : "1080P",
        inputImages: [asset("first-frame.png", index === 0 ? undefined : "first_frame")],
      });

      const body = requirePostJsonCall(index).body ?? {};
      expect(body.image).toEqual({ url: "https://example.com/first-frame.png" });
      expect(body).toMatchObject({
        model,
        duration: 15,
        resolution: index === 0 ? "480p" : "1080p",
      });
      expect(body).not.toHaveProperty("aspect_ratio");
      expect(result.model).toBe(model);
    }
  });

  it("rejects unsupported 1.5 modes before submitting a request", async () => {
    const cases: Array<
      Pick<VideoGenerationRequest, "model" | "inputImages" | "inputVideos"> & { error: string }
    > = [
      {
        model: "grok-imagine-video-1.5",
        inputImages: undefined,
        error: "xAI grok-imagine-video-1.5 requires exactly one first-frame image.",
      },
      {
        model: "grok-imagine-video-1.5-preview",
        inputImages: [asset("reference.png", "reference_image")],
        error: "xAI grok-imagine-video-1.5 supports only an ordinary or first_frame image.",
      },
      {
        model: "grok-imagine-video-1.5-2026-05-30",
        inputImages: [asset("first.png"), asset("second.png", "first_frame")],
        error: "xAI grok-imagine-video-1.5 requires exactly one first-frame image.",
      },
      {
        model: "grok-imagine-video-1.5",
        inputImages: undefined,
        inputVideos: [asset("input.mp4")],
        error: "xAI grok-imagine-video-1.5 does not support video inputs.",
      },
    ];

    for (const testCase of cases) {
      await expect(generate(testCase)).rejects.toThrow(testCase.error);
    }
    expect(resolveApiKeyForProviderMock).not.toHaveBeenCalled();
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("applies configured xAI request policy to video generation requests", async () => {
    const dispatcherPolicy = { proxyUrl: "http://proxy.example:3128" };
    const requestPolicy = {
      proxy: { mode: "env-proxy" as const },
      allowPrivateNetwork: true,
    };
    resolveProviderHttpRequestConfigMock.mockImplementationOnce((params) => ({
      baseUrl: params.baseUrl ?? params.defaultBaseUrl,
      allowPrivateNetwork: true,
      headers: new Headers(params.defaultHeaders),
      dispatcherPolicy: dispatcherPolicy as never,
    }));
    mockXaiVideoTask("req_policy");

    await generate({
      cfg: {
        models: { providers: { xai: { request: requestPolicy } } },
      } as never,
    });

    expect(sanitizeConfiguredModelProviderRequestMock).toHaveBeenCalledWith(requestPolicy);
    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "xai",
        capability: "video",
        request: requestPolicy,
      }),
    );
    expect(resolveProviderHttpRequestConfigMock.mock.calls[0]?.[0]).not.toHaveProperty(
      "allowPrivateNetwork",
    );
    expect(requirePostJsonCall()).toMatchObject({ allowPrivateNetwork: true, dispatcherPolicy });
    expect(fetchWithTimeoutGuardedMock.mock.calls.map((call) => call[4])).toMatchObject([
      {
        ssrfPolicy: { allowPrivateNetwork: true },
        dispatcherPolicy,
        auditContext: "xai-video-status",
      },
      {
        ssrfPolicy: { allowPrivateNetwork: true },
        dispatcherPolicy,
        auditContext: "xai-video-download",
      },
    ]);
  });

  it("rejects generated video downloads that exceed the configured media cap", async () => {
    mockXaiVideoRequest("req_too_large");
    mockPoll({
      request_id: "req_too_large",
      status: "done",
      video: { url: "https://cdn.x.ai/too-large.mp4" },
    });
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response("too-large", {
        headers: { "content-type": "video/mp4" },
      }),
    );

    await expect(
      generate({
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
      }),
    ).rejects.toThrow("xAI generated video download exceeds 1 bytes");
  });

  it("bounds an unbounded successful xAI poll JSON body and cancels the stream", async () => {
    const oversized = oversizedJsonResponse();
    mockSubmit(streamedJsonResponse({ request_id: "req_poll_oversized" }));
    fetchWithTimeoutMock.mockResolvedValueOnce(oversized.response);

    await expect(generate()).rejects.toThrow(
      "xAI video generation response: JSON response exceeds 16777216 bytes",
    );
    expect(oversized.state.canceled).toBe(true);
    expect(oversized.state.enqueuedBytes).toBeLessThan(64 * 1024 * 1024);
  });

  it.each([
    { kind: "malformed", response: () => Response.json([]) },
    {
      kind: "non-JSON",
      response: () =>
        new Response("<html>Unexpected token < in JSON</html>", {
          headers: { "content-type": "text/html" },
        }),
    },
  ])("wraps $kind successful xAI create responses", async ({ response }) => {
    mockSubmit(response());
    await expect(generate()).rejects.toThrow("xAI video generation response malformed");
  });

  it("treats `cancelled` as a terminal failure", async () => {
    mockXaiVideoRequest("req_cancelled");
    mockPoll({ request_id: "req_cancelled", status: "cancelled" });

    await expect(generate()).rejects.toThrow("xAI video generation cancelled");
  });

  it("rejects completed xAI poll responses without output URLs as malformed", async () => {
    mockXaiVideoRequest("req_no_video");
    mockPoll({ request_id: "req_no_video", status: "done", video: {} });

    await expect(generate()).rejects.toThrow("xAI video generation response malformed");
  });

  it("normalizes the xAI 'pending' poll status to 'processing' and keeps polling until done", async () => {
    vi.useFakeTimers();
    try {
      mockPoll({ request_id: "req_pending", status: "pending" });
      mockXaiVideoTask("req_pending");

      const pending = generate({
        durationSeconds: 6,
        aspectRatio: "9:16",
        resolution: "720P",
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;

      expect((fetchWithTimeoutMock.mock.calls as unknown[]).length).toBeGreaterThanOrEqual(2);
      expect(result).toMatchObject({
        videos: [{ mimeType: "video/mp4" }],
        metadata: { requestId: "req_pending" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a single unroled image as xAI first-frame image-to-video", async () => {
    mockXaiVideoTask("req_image");

    const result = await generate({
      inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
    });

    const request = requirePostJsonCall();
    expect(request.url).toBe("https://api.x.ai/v1/videos/generations");
    const image = request.body?.image as { url?: string } | undefined;
    expect(image?.url).toMatch(/^data:image\/png;base64,/u);
    const body = request.body ?? {};
    expect(body).not.toHaveProperty("reference_images");
    expect(body).not.toHaveProperty("aspect_ratio");
    expect(body.resolution).toBe("480p");
    expect(result.metadata?.mode).toBe("generate");
  });

  it("sends reference_image roles through xAI reference_images mode", async () => {
    mockXaiVideoTask("req_refs");

    const result = await generate({
      durationSeconds: 12,
      aspectRatio: "9:16",
      resolution: "720P",
      inputImages: [asset("subject.png", "reference_image"), asset("style.png", "reference_image")],
    });

    const request = requirePostJsonCall();
    expect(request.url).toBe("https://api.x.ai/v1/videos/generations");
    expect(request.body?.reference_images).toEqual([
      { url: "https://example.com/subject.png" },
      { url: "https://example.com/style.png" },
    ]);
    expect(request.body).toMatchObject({
      duration: 10,
      aspect_ratio: "9:16",
      resolution: "720p",
    });
    const body = request.body ?? {};
    expect(body).not.toHaveProperty("image");
    expect(result.metadata?.mode).toBe("referenceToVideo");
  });

  it("rejects mixed xAI first-frame and reference-image roles", async () => {
    await expect(
      generate({
        inputImages: [
          asset("subject.png", "reference_image"),
          asset("first-frame.png", "first_frame"),
        ],
      }),
    ).rejects.toThrow(
      "xAI reference-image video generation requires every image role to be reference_image.",
    );
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("routes video inputs to the extension endpoint when duration is set", async () => {
    mockXaiVideoTask("req_extend");

    await generate({
      durationSeconds: 15,
      aspectRatio: "9:16",
      resolution: "1080P",
      inputVideos: [asset("input.mp4")],
    });

    const request = requirePostJsonCall();
    expect(request.body?.video).toEqual({ url: "https://example.com/input.mp4" });
    expect(request).toMatchObject({
      url: "https://api.x.ai/v1/videos/extensions",
      body: { duration: 10 },
    });
    expect(request.body).not.toHaveProperty("aspect_ratio");
    expect(request.body).not.toHaveProperty("resolution");
  });
});

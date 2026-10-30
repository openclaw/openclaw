import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-shared";
import { resolveProviderHttpRequestConfigWithOriginTrust } from "openclaw/plugin-sdk/provider-http";
import {
  getProviderHttpMocks,
  requireFirstPostJsonRecordRequest,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  expectExplicitVideoGenerationCapabilities,
  expectUnifiedModelCatalogEntries,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOpenRouterVideoGenerationProvider,
  listOpenRouterVideoModelCatalog,
} from "./video-generation-provider.js";

const SUPPORTED_DURATIONS_HINT = Symbol.for("openclaw.videoGeneration.supportedDurations");
const CUSTOM_BASE = "https://custom.openrouter.test/openrouter/api/v1";
const LEGACY_BASE = "https://custom.openrouter.test/api/v1";

const {
  assertOkOrThrowHttpErrorMock,
  fetchWithTimeoutGuardedMock,
  postJsonRequestMock,
  resolveApiKeyForProviderMock,
  resolveProviderHttpRequestConfigMock,
  waitProviderOperationPollIntervalMock,
} = getProviderHttpMocks();

resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "openrouter-key" });
waitProviderOperationPollIntervalMock.mockResolvedValue(undefined);
resolveProviderHttpRequestConfigMock.mockImplementation((params) => {
  const result = resolveProviderHttpRequestConfigWithOriginTrust(params);
  return { ...result, dispatcherPolicy: result.dispatcherPolicy };
});

function generateVideo(
  overrides: Partial<VideoGenerationRequest> & {
    [SUPPORTED_DURATIONS_HINT]?: readonly number[];
  } = {},
) {
  return buildOpenRouterVideoGenerationProvider().generateVideo({
    provider: "openrouter",
    model: "google/veo-3.1",
    cfg: {},
    prompt: "a lobster",
    ...overrides,
  });
}

function customConfig(request?: ModelProviderConfig["request"], baseUrl = CUSTOM_BASE) {
  return {
    models: {
      providers: {
        openrouter: {
          baseUrl,
          models: [],
          request,
        },
      },
    },
  };
}

function catalogContext(
  config: Parameters<typeof listOpenRouterVideoModelCatalog>[0]["config"],
  apiKey = "OPENROUTER_API_KEY",
  discoveryApiKey = "resolved-openrouter-key",
) {
  return {
    config,
    env: {},
    resolveProviderApiKey: () => ({ apiKey, discoveryApiKey }),
    resolveProviderAuth: () => ({
      apiKey,
      discoveryApiKey,
      mode: "api_key" as const,
      source: "env" as const,
    }),
  };
}

function resetVideoMocks() {
  assertOkOrThrowHttpErrorMock.mockClear();
  fetchWithTimeoutGuardedMock.mockReset();
  postJsonRequestMock.mockReset();
  resolveApiKeyForProviderMock.mockClear();
  resolveProviderHttpRequestConfigMock.mockClear();
  waitProviderOperationPollIntervalMock.mockClear();
}

function completedVideoJob(url = "/api/v1/videos/job-123/content?index=0") {
  return {
    id: "job-123",
    polling_url: "/api/v1/videos/job-123",
    status: "completed",
    unsigned_urls: [url],
  };
}

function pendingVideoJob(polling_url = "/api/v1/videos/job-123") {
  return { id: "job-123", polling_url, status: "in_progress" };
}

function releasedJson(value: unknown) {
  return {
    response: Response.json(value),
    release: vi.fn(async () => {}),
  };
}

function mockCatalog(data: unknown[]) {
  fetchWithTimeoutGuardedMock.mockResolvedValueOnce(releasedJson({ data }));
}

function releasedOversizedJsonStream() {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    release: vi.fn(async () => {}),
    wasCanceled: () => canceled,
  };
}

function releasedVideo(params = { contentType: "video/mp4", bytes: "mp4-bytes" }) {
  return {
    response: new Response(Buffer.from(params.bytes), {
      status: 200,
      headers: { "content-type": params.contentType },
    }),
    release: vi.fn(async () => {}),
  };
}

function requireFetchCallHeaders(index: number): Headers {
  const { headers } = requireRecord(
    fetchWithTimeoutGuardedMock.mock.calls[index]?.[1],
    "fetch init",
  );
  if (!(headers instanceof Headers)) {
    throw new Error("expected OpenRouter fetch headers");
  }
  return headers;
}

const requireRecord = createRequireRecord("object", "label-not-object");

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectOpenRouterFetchCall(index: number, url: string, operation: string) {
  const call = fetchWithTimeoutGuardedMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected OpenRouter fetch call ${index + 1}`);
  }
  const [actualUrl, init, timeoutMs, fetchFn, guardOptions] = call;
  expect(actualUrl).toBe(url);
  expect(requireRecord(init, "OpenRouter fetch init").method).toBe("GET");
  expect(Number.isInteger(timeoutMs)).toBe(true);
  expect(timeoutMs).toBeGreaterThan(0);
  expect(fetchFn).toBe(fetch);
  expect(requireRecord(guardOptions, "OpenRouter fetch guard options").auditContext).toBe(
    `openrouter-video-${operation}`,
  );
}

function requireFetchGuardOptions(index: number): Record<string, unknown> {
  return requireRecord(
    fetchWithTimeoutGuardedMock.mock.calls[index]?.[4],
    "OpenRouter fetch guard options",
  );
}

const requirePostJsonParams = () =>
  requireFirstPostJsonRecordRequest(postJsonRequestMock, "OpenRouter video request");

function imagePart(bytes: string, mime = "image/png") {
  return {
    type: "image_url",
    image_url: { url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` },
  };
}

describe("openrouter video generation provider", () => {
  beforeEach(clearLiveCatalogCacheForTests);

  afterEach(resetVideoMocks);

  it("rejects a duration that rounds to zero before submission", async () => {
    await expect(generateVideo({ prompt: "a lobster", durationSeconds: 0.4 })).rejects.toThrow(
      "durationSeconds must be a positive duration",
    );
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("declares explicit mode capabilities", () => {
    const provider = buildOpenRouterVideoGenerationProvider();

    expectExplicitVideoGenerationCapabilities(provider);
    expect(provider.id).toBe("openrouter");
    expect(provider.defaultModel).toBe("google/veo-3.1-fast");
    expect(provider.capabilities.generate).toEqual(
      expect.objectContaining({
        supportsAudio: true,
        supportedDurationSeconds: [4, 6, 8],
        resolutions: ["720P", "1080P"],
        aspectRatios: ["16:9", "9:16"],
      }),
    );
    expect(provider.capabilities.imageToVideo?.enabled).toBe(true);
    expect(provider.capabilities.videoToVideo?.enabled).toBe(false);
  });

  it("maps OpenRouter video model discovery into unified catalog rows", async () => {
    const requestOverrides = {
      allowPrivateNetwork: true,
      headers: { "X-OpenRouter-Catalog": "enabled" },
    };
    mockCatalog([
      {
        id: "google/veo-3.1",
        name: "Veo 3.1",
        canonical_slug: "google/veo-3.1",
        description: "Google video generation model",
        created: 1_700_000_000,
        generate_audio: true,
        supported_aspect_ratios: ["16:9"],
        supported_durations: [5, 8],
        supported_frame_images: ["first_frame", "last_frame"],
        supported_resolutions: ["720p"],
        supported_sizes: ["1280x720"],
        allowed_passthrough_parameters: ["provider"],
        pricing_skus: { generate: "0.50" },
      },
    ]);

    const rows = await listOpenRouterVideoModelCatalog(
      catalogContext(customConfig(requestOverrides)),
    );

    expectOpenRouterFetchCall(0, `${CUSTOM_BASE}/videos/models`, "models");
    expect(requireFetchCallHeaders(0).get("authorization")).toBe("Bearer resolved-openrouter-key");
    expect(requireFetchCallHeaders(0).get("x-openrouter-catalog")).toBe("enabled");
    expect(requireFetchGuardOptions(0).ssrfPolicy).toEqual({ allowPrivateNetwork: true });
    expectUnifiedModelCatalogEntries(rows, {
      provider: "openrouter",
      kind: "video_generation",
    });
    expect(rows).toEqual([
      expect.objectContaining({
        model: "google/veo-3.1",
        label: "Veo 3.1",
        source: "live",
        capabilities: expect.objectContaining({
          canonicalSlug: "google/veo-3.1",
          description: "Google video generation model",
          created: 1_700_000_000,
          pricingSkus: { generate: "0.50" },
          allowedPassthroughParameters: ["provider"],
          videoToVideo: { enabled: false },
          generate: expect.objectContaining({
            supportsAudio: true,
            supportedDurationSeconds: [5, 8],
            aspectRatios: ["16:9"],
            resolutions: ["720P"],
            sizes: ["1280x720"],
          }),
          imageToVideo: expect.objectContaining({
            enabled: true,
            maxInputImages: 2,
          }),
        }),
      }),
    ]);
  });

  it("keeps valid rows when OpenRouter video catalog data is mixed with malformed entries", async () => {
    mockCatalog([
      null,
      "malformed-row",
      ["nested-array"],
      { id: "google/veo-3.1", name: "Veo 3.1" },
    ]);

    const rows = await listOpenRouterVideoModelCatalog(catalogContext({} as never, "k", "d"));

    expect(rows?.map((row) => row.model)).toEqual(["google/veo-3.1"]);
  });

  it("does not cache a malformed OpenRouter video catalog envelope", async () => {
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(releasedJson({}));
    mockCatalog([{ id: "google/veo-3.1", name: "Veo 3.1" }]);

    const ctx = catalogContext({} as never, "k", "d");

    await expect(listOpenRouterVideoModelCatalog(ctx)).rejects.toThrow(
      /OpenRouter video models request failed.*malformed JSON response/,
    );
    await expect(listOpenRouterVideoModelCatalog(ctx)).resolves.toMatchObject([
      { model: "google/veo-3.1" },
    ]);
    expect(fetchWithTimeoutGuardedMock).toHaveBeenCalledTimes(2);
  });

  it("lets configured auth replace the OpenRouter catalog default", async () => {
    mockCatalog([]);

    await listOpenRouterVideoModelCatalog(
      catalogContext(
        {
          models: {
            providers: {
              openrouter: {
                baseUrl: "https://openrouter.ai/api/v1",
                models: [],
                request: { auth: { mode: "authorization-bearer", token: "test-auth" } },
              },
            },
          },
        },
        "key",
        "test-key",
      ),
    );

    expect(requireFetchCallHeaders(0).get("authorization")).toBe("Bearer test-auth");
  });

  it("keys live OpenRouter video catalog cache by request policy", async () => {
    mockCatalog([{ id: "google/veo-3.1-fast", name: "Veo first policy" }]);
    mockCatalog([{ id: "google/veo-3.1-quality", name: "Veo second policy" }]);

    const firstRows = await listOpenRouterVideoModelCatalog(
      catalogContext(
        customConfig({
          allowPrivateNetwork: true,
          headers: { "X-OpenRouter-Policy": "first" },
        }),
      ),
    );
    const secondRows = await listOpenRouterVideoModelCatalog(
      catalogContext(
        customConfig({
          allowPrivateNetwork: false,
          headers: { "X-OpenRouter-Policy": "second" },
        }),
      ),
    );

    expect(fetchWithTimeoutGuardedMock).toHaveBeenCalledTimes(2);
    expect(requireFetchCallHeaders(0).get("x-openrouter-policy")).toBe("first");
    expect(requireFetchCallHeaders(1).get("x-openrouter-policy")).toBe("second");
    expect(requireFetchGuardOptions(0).ssrfPolicy).toEqual({ allowPrivateNetwork: true });
    expect(requireFetchGuardOptions(1).ssrfPolicy).toBeUndefined();
    expect(firstRows?.[0]?.model).toBe("google/veo-3.1-fast");
    expect(secondRows?.[0]?.model).toBe("google/veo-3.1-quality");
  });

  it("cancels oversized OpenRouter video catalog success bodies", async () => {
    const oversized = releasedOversizedJsonStream();
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(oversized);

    await expect(listOpenRouterVideoModelCatalog(catalogContext(customConfig()))).rejects.toThrow(
      "OpenRouter video models request failed: JSON response exceeds 16777216 bytes",
    );
    expect(oversized.wasCanceled()).toBe(true);
    expect(oversized.release).toHaveBeenCalledOnce();
  });

  it("skips live OpenRouter video catalog discovery without an API key", async () => {
    await expect(
      listOpenRouterVideoModelCatalog({
        config: {} as never,
        env: {},
        resolveProviderApiKey: () => ({ apiKey: "OPENROUTER_API_KEY" }),
        resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
      }),
    ).resolves.toBeNull();
    expect(fetchWithTimeoutGuardedMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: "the first normalized duplicate", model: "google/veo-3.1", found: true },
    { name: "an absent model", model: "google/missing", found: false },
    { name: "an untrimmed request", model: " google/veo-3.1 ", found: false },
    { name: "an empty request", model: "", found: false },
  ])("resolves live capabilities for $name", async ({ model, found }) => {
    const requestOverrides = {
      allowPrivateNetwork: true,
      headers: { "X-OpenRouter-Capabilities": "enabled" },
    };
    mockCatalog([
      null,
      "malformed",
      [],
      {},
      { id: " " },
      { id: "google/other", supported_durations: [10] },
      {
        id: " google/veo-3.1 ",
        name: "Veo 3.1",
        generate_audio: false,
        supported_durations: [5],
        supported_resolutions: ["720p"],
        allowed_passthrough_parameters: ["seed"],
      },
      { id: "google/veo-3.1", supported_durations: [8], generate_audio: true },
    ]);

    const provider = buildOpenRouterVideoGenerationProvider();
    const capabilities = await provider.resolveModelCapabilities?.({
      provider: "openrouter",
      model,
      cfg: customConfig(requestOverrides),
      timeoutMs: 12_345,
    });

    expectOpenRouterFetchCall(0, `${CUSTOM_BASE}/videos/models`, "models");
    expect(requireFetchCallHeaders(0).get("x-openrouter-capabilities")).toBe("enabled");
    expect(requireFetchGuardOptions(0).ssrfPolicy).toEqual({ allowPrivateNetwork: true });
    expect(fetchWithTimeoutGuardedMock.mock.calls[0]?.[2]).toBe(12_345);
    if (!found) {
      expect(capabilities).toBeUndefined();
      return;
    }
    const resolvedCapabilities = requireRecord(capabilities, "resolved capabilities");
    expect(resolvedCapabilities.providerOptions).toEqual({
      callback_url: "string",
      seed: "number",
    });
    expectRecordFields(requireRecord(resolvedCapabilities.generate, "generate capabilities"), {
      supportsAudio: false,
      supportedDurationSeconds: [5],
      resolutions: ["720P"],
    });
  });

  it("clamps direct exact integer durations to static OpenRouter supported values", async () => {
    postJsonRequestMock.mockResolvedValue(releasedJson(completedVideoJob()));
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(releasedVideo());

    await generateVideo({ durationSeconds: 7 });

    expect(requireRecord(requirePostJsonParams().body, "OpenRouter request body").duration).toBe(8);
  });

  it.each([
    { hint: [5], expected: 5 },
    { hint: [], expected: 6 },
  ])("uses live duration hint $hint and static values when empty", async ({ hint, expected }) => {
    postJsonRequestMock.mockResolvedValue(releasedJson(completedVideoJob()));
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(releasedVideo());

    await generateVideo({
      durationSeconds: 5,
      [SUPPORTED_DURATIONS_HINT]: hint,
    });

    expect(requireRecord(requirePostJsonParams().body, "OpenRouter request body").duration).toBe(
      expected,
    );
  });

  it("submits OpenRouter video jobs, polls completion, and downloads the result", async () => {
    postJsonRequestMock.mockResolvedValue(releasedJson(pendingVideoJob()));
    fetchWithTimeoutGuardedMock
      .mockResolvedValueOnce(releasedJson({ id: "job-123", status: "in_progress" }))
      .mockResolvedValueOnce(
        releasedJson({
          id: "job-123",
          generation_id: "gen-123",
          status: "completed",
          model: "google/veo-3.1",
          unsigned_urls: ["/api/v1/videos/job-123/content?index=0"],
          usage: { cost: 0.25, is_byok: false },
        }),
      )
      .mockResolvedValueOnce(releasedVideo());

    const requestOverrides = {
      proxy: { mode: "explicit-proxy" as const, url: "https://proxy.example" },
    };

    const result = await generateVideo({
      prompt: "A chrome sphere glides across a quiet moonlit beach",
      durationSeconds: 5.4,
      aspectRatio: "16:9",
      resolution: "720P",
      size: "1280x720",
      audio: false,
      inputImages: [
        { buffer: Buffer.from("first-frame"), mimeType: "image/png" },
        { buffer: Buffer.from("last-frame"), mimeType: "image/png", role: "last_frame" },
        {
          buffer: Buffer.from("style-reference"),
          mimeType: "image/webp",
          role: "reference_image",
        },
      ],
      providerOptions: {
        callback_url: "https://example.com/openrouter-video-hook",
        seed: 42,
      },
      timeoutMs: 120_000,
      cfg: customConfig(requestOverrides, LEGACY_BASE),
    });

    const postParams = requirePostJsonParams();
    expect(postParams.url).toBe(`${LEGACY_BASE}/videos`);
    expect(postParams.allowPrivateNetwork).toBe(false);
    expect(postParams.body).toEqual({
      model: "google/veo-3.1",
      prompt: "A chrome sphere glides across a quiet moonlit beach",
      duration: 6,
      resolution: "720p",
      aspect_ratio: "16:9",
      size: "1280x720",
      generate_audio: false,
      frame_images: [
        { ...imagePart("first-frame"), frame_type: "first_frame" },
        { ...imagePart("last-frame"), frame_type: "last_frame" },
      ],
      input_references: [imagePart("style-reference", "image/webp")],
      callback_url: "https://example.com/openrouter-video-hook",
      seed: 42,
    });
    expectOpenRouterFetchCall(0, `${LEGACY_BASE}/videos/job-123`, "status");
    expect(requireFetchCallHeaders(0).get("authorization")).toBe("Bearer openrouter-key");
    expectOpenRouterFetchCall(1, `${LEGACY_BASE}/videos/job-123`, "status");
    expectOpenRouterFetchCall(2, `${LEGACY_BASE}/videos/job-123/content?index=0`, "download");
    expect(requireFetchCallHeaders(2).get("authorization")).toBe("Bearer openrouter-key");
    expect(waitProviderOperationPollIntervalMock).toHaveBeenCalledOnce();
    expect(result.videos[0]?.buffer).toBeInstanceOf(Buffer);
    expect(result.videos[0]).toMatchObject({
      buffer: Buffer.from("mp4-bytes"),
      mimeType: "video/mp4",
    });
    expect(result.metadata).toEqual({
      jobId: "job-123",
      status: "completed",
      generationId: "gen-123",
      usage: { cost: 0.25, is_byok: false },
    });
  });

  it("returns unsigned URL-only videos when downloads exceed the configured media cap", async () => {
    postJsonRequestMock.mockResolvedValue(
      releasedJson(completedVideoJob("  https://cdn.openrouter.test/video.mp4  ")),
    );
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(
      releasedVideo({ contentType: "video/mp4", bytes: "too-large" }),
    );

    const result = await generateVideo({
      cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } } as never,
    });

    expect(result.videos).toEqual([
      {
        url: "https://cdn.openrouter.test/video.mp4",
        mimeType: "video/mp4",
        fileName: "video-1.mp4",
      },
    ]);
  });

  it("rejects malformed numeric seed values before submitting video jobs", async () => {
    await expect(generateVideo({ providerOptions: { seed: 42.9 } })).rejects.toThrow(
      "OpenRouter video seed must be an integer",
    );

    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("wraps malformed successful OpenRouter submit responses", async () => {
    postJsonRequestMock.mockResolvedValue(releasedJson([]));

    await expect(generateVideo()).rejects.toThrow("OpenRouter video generation response malformed");
  });

  it("wraps non-JSON successful OpenRouter submit responses", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
      release: vi.fn(async () => {}),
    });

    await expect(generateVideo()).rejects.toThrow("OpenRouter video generation response malformed");
  });

  it("bounds oversized successful OpenRouter submit responses", async () => {
    const oversized = releasedOversizedJsonStream();
    postJsonRequestMock.mockResolvedValue(oversized);

    await expect(generateVideo()).rejects.toThrow(
      "OpenRouter video generation: JSON response exceeds 16777216 bytes",
    );
    expect(oversized.wasCanceled()).toBe(true);
  });

  it.each([
    ["nearly_done", undefined, "OpenRouter video generation response malformed"],
    ["failed", "  ", "OpenRouter video generation failed"],
  ])("rejects poll status %s without waiting for timeout", async (status, error, expected) => {
    postJsonRequestMock.mockResolvedValue(
      releasedJson({ ...pendingVideoJob(), status: "pending" }),
    );
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(
      releasedJson({
        id: "job-123",
        status,
        error,
      }),
    );

    await expect(generateVideo()).rejects.toThrow(expected);
    expect(waitProviderOperationPollIntervalMock).not.toHaveBeenCalled();
  });

  it("rejects malformed OpenRouter completed output URL arrays", async () => {
    postJsonRequestMock.mockResolvedValue(
      releasedJson({
        ...completedVideoJob(),
        unsigned_urls: { 0: "/api/v1/videos/job-123/content?index=0" },
      }),
    );

    await expect(generateVideo()).rejects.toThrow("OpenRouter video generation response malformed");
  });

  it("does not forward auth headers to cross-origin polling URLs", async () => {
    postJsonRequestMock.mockResolvedValue(
      releasedJson({
        id: "job-123",
        polling_url: "https://polling.example.test/videos/job-123",
        status: "pending",
      }),
    );
    fetchWithTimeoutGuardedMock
      .mockResolvedValueOnce(
        releasedJson({
          id: "job-123",
          status: "completed",
          unsigned_urls: ["https://cdn.openrouter.test/video.mp4"],
        }),
      )
      .mockResolvedValueOnce(releasedVideo());

    await generateVideo();

    expectOpenRouterFetchCall(0, "https://polling.example.test/videos/job-123", "status");
    expect(requireFetchCallHeaders(0).get("authorization")).toBeNull();
    expectOpenRouterFetchCall(1, "https://cdn.openrouter.test/video.mp4", "download");
    expect(requireFetchCallHeaders(1).get("authorization")).toBeNull();
  });

  it("falls back to the documented content endpoint when a completed job has no output URL", async () => {
    postJsonRequestMock.mockResolvedValue(
      releasedJson({
        id: "job-123",
        polling_url: "https://openrouter.ai/api/v1/videos/job-123",
        status: "completed",
      }),
    );
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(
      releasedVideo({ contentType: "video/webm", bytes: "webm-bytes" }),
    );

    const result = await generateVideo();

    expectOpenRouterFetchCall(
      0,
      "https://openrouter.ai/api/v1/videos/job-123/content?index=0",
      "download",
    );
    expect(result.videos[0]?.buffer).toBeInstanceOf(Buffer);
    expect(result.videos[0]).toMatchObject({
      buffer: Buffer.from("webm-bytes"),
      fileName: "video-1.webm",
    });
  });

  it("rejects video reference inputs", async () => {
    await expect(
      generateVideo({
        prompt: "remix this clip",
        inputVideos: [{ url: "https://example.com/source.mp4", mimeType: "video/mp4" }],
      }),
    ).rejects.toThrow("does not support video reference inputs");
  });
  it.each([
    ["JSON error", "application/json", '{"error":"denied"}'],
    ["problem JSON", "application/problem+json", '{"title":"denied"}'],
    ["HTML", "text/html; charset=utf-8", "<html>sign in</html>"],
    ["empty video", "video/mp4", ""],
  ])(
    "rejects a successful %s response as a downloaded OpenRouter video",
    async (_name, contentType, bytes) => {
      postJsonRequestMock.mockResolvedValue(
        releasedJson(completedVideoJob("https://cdn.openrouter.test/video.mp4")),
      );
      const download = releasedVideo({ contentType, bytes });
      fetchWithTimeoutGuardedMock.mockResolvedValueOnce(download);

      await expect(generateVideo()).rejects.toThrow(
        "OpenRouter generated video download: malformed video response",
      );

      expect(download.release).toHaveBeenCalledTimes(1);
    },
  );
});

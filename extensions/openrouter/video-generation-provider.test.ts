import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-shared";
import { getProviderHttpMocks } from "openclaw/plugin-sdk/provider-http-test-mocks";
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
const customBaseUrl = "https://custom.openrouter.test/openrouter/api/v1";
const generationBaseUrl = "https://custom.openrouter.test/api/v1";

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
  const request = params.request;
  const headers = new Headers(params.defaultHeaders);
  for (const [key, value] of Object.entries(request?.headers ?? {})) {
    headers.set(key, value);
  }
  if (request?.auth?.mode === "authorization-bearer") {
    headers.set("Authorization", `Bearer ${request.auth.token}`);
  } else if (request?.auth?.mode === "header") {
    headers.delete("Authorization");
    headers.set(request.auth.headerName, `${request.auth.prefix ?? ""}${request.auth.value}`);
  }
  return {
    baseUrl: params.baseUrl ?? params.defaultBaseUrl ?? "https://openrouter.ai/api/v1",
    allowPrivateNetwork: request?.allowPrivateNetwork === true,
    headers,
    dispatcherPolicy: undefined,
    requestConfig: {},
  };
});

function generateVideo(
  overrides: Partial<VideoGenerationRequest> & {
    prompt: string;
    [SUPPORTED_DURATIONS_HINT]?: readonly number[];
  },
) {
  return buildOpenRouterVideoGenerationProvider().generateVideo({
    provider: "openrouter",
    model: "google/veo-3.1",
    cfg: {},
    ...overrides,
  });
}

function catalogContext(
  config: Parameters<typeof listOpenRouterVideoModelCatalog>[0]["config"],
  apiKey: string,
  discoveryApiKey: string,
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

function videoConfig(
  request: Parameters<typeof resolveProviderHttpRequestConfigMock>[0]["request"],
  baseUrl = customBaseUrl,
) {
  return { models: { providers: { openrouter: { baseUrl, models: [], request } } } };
}

function requestCatalogContext(request: Parameters<typeof videoConfig>[0]) {
  return catalogContext(videoConfig(request), "OPENROUTER_API_KEY", "resolved-openrouter-key");
}

function resetVideoMocks() {
  assertOkOrThrowHttpErrorMock.mockClear();
  fetchWithTimeoutGuardedMock.mockReset();
  postJsonRequestMock.mockReset();
  resolveApiKeyForProviderMock.mockClear();
  resolveProviderHttpRequestConfigMock.mockClear();
  waitProviderOperationPollIntervalMock.mockClear();
}

function releasedResponse(body: BodyInit | null | undefined, contentType = "application/json") {
  return {
    response: new Response(body, { headers: { "content-type": contentType } }),
    release: vi.fn(async () => {}),
  };
}
function releasedJson(value: unknown) {
  return releasedResponse(JSON.stringify(value));
}
function catalogRows(...data: unknown[]) {
  return releasedJson({ data });
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
    ...releasedResponse(stream),
    wasCanceled: () => canceled,
  };
}

function releasedVideo(params = { contentType: "video/mp4", bytes: "mp4-bytes" }) {
  return releasedResponse(Buffer.from(params.bytes), params.contentType);
}

function jobResponse(patch: Record<string, unknown>) {
  return releasedJson({ id: "job-123", polling_url: "/api/v1/videos/job-123", ...patch });
}

function completeVideo() {
  postJsonRequestMock.mockResolvedValue(
    jobResponse({
      status: "completed",
      unsigned_urls: ["/api/v1/videos/job-123/content?index=0"],
    }),
  );
  fetchWithTimeoutGuardedMock.mockResolvedValueOnce(releasedVideo());
}

type OpenRouterVideoProvider = ReturnType<typeof buildOpenRouterVideoGenerationProvider>;
type OpenRouterVideoResult = Awaited<ReturnType<OpenRouterVideoProvider["generateVideo"]>>;

function requireGenerateCapabilities(provider: OpenRouterVideoProvider) {
  const capabilities = provider.capabilities.generate;
  if (!capabilities) {
    throw new Error("expected OpenRouter generate capabilities");
  }
  return capabilities;
}

function requireFetchCallHeaders(index: number): Headers {
  const init = requireRecord(fetchWithTimeoutGuardedMock.mock.calls[index]?.[1], "fetch init");
  const headers = init.headers;
  expect(headers).toBeInstanceOf(Headers);
  if (!(headers instanceof Headers)) {
    throw new Error("expected OpenRouter fetch headers");
  }
  return headers;
}

const requireRecord = createRequireRecord("object", "label-not-object");

function expectRecordFields(actual: unknown, fields: Record<string, unknown>) {
  const record = requireRecord(actual, "record fields");
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectOpenRouterFetchCall(
  index: number,
  url: string,
  stage: "models" | "status" | "download",
) {
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
    `openrouter-video-${stage}`,
  );
}

function requireFetchGuardOptions(index: number): Record<string, unknown> {
  return requireRecord(fetchWithTimeoutGuardedMock.mock.calls[index]?.[4], "fetch options");
}

function requirePostJsonParams(index = 0): Record<string, unknown> {
  return requireRecord(postJsonRequestMock.mock.calls[index]?.[0], "POST params");
}

function callArg(calls: unknown[][], index = 0, argIndex = 0) {
  return calls[index]?.[argIndex];
}

function requireGeneratedVideoBuffer(result: OpenRouterVideoResult) {
  const video = result.videos[0]!;
  expect(video.buffer).toBeInstanceOf(Buffer);
  return { video, buffer: video.buffer! };
}

function imagePart(bytes: string, mime = "image/png") {
  return {
    type: "image_url",
    image_url: { url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` },
  };
}

describe("openrouter video generation provider", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

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
    const generateCapabilities = requireGenerateCapabilities(provider);
    expect(generateCapabilities.supportsAudio).toBe(true);
    expect(generateCapabilities.supportedDurationSeconds).toEqual([4, 6, 8]);
    expect(generateCapabilities.resolutions).toEqual(["720P", "1080P"]);
    expect(generateCapabilities.aspectRatios).toEqual(["16:9", "9:16"]);
    expect(provider.capabilities.imageToVideo?.enabled).toBe(true);
    expect(provider.capabilities.videoToVideo?.enabled).toBe(false);
  });

  it("maps OpenRouter video model discovery into unified catalog rows", async () => {
    const requestOverrides = {
      allowPrivateNetwork: true,
      headers: { "X-OpenRouter-Catalog": "enabled" },
    };
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(
      catalogRows(null, "malformed-row", ["nested-array"], {
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
      }),
    );

    const rows = await listOpenRouterVideoModelCatalog(requestCatalogContext(requestOverrides));

    expectRecordFields(callArg(resolveProviderHttpRequestConfigMock.mock.calls), {
      baseUrl: "https://custom.openrouter.test/openrouter/api/v1",
      defaultBaseUrl: "https://openrouter.ai/api/v1",
      provider: "openrouter",
      capability: "video",
      request: requestOverrides,
    });
    expectOpenRouterFetchCall(0, `${customBaseUrl}/videos/models`, "models");
    expect(requireFetchCallHeaders(0).get("authorization")).toBe("Bearer resolved-openrouter-key");
    expect(requireFetchCallHeaders(0).get("x-openrouter-catalog")).toBe("enabled");
    expect(requireFetchGuardOptions(0).ssrfPolicy).toEqual({ allowPrivateNetwork: true });
    expectUnifiedModelCatalogEntries(rows, {
      provider: "openrouter",
      kind: "video_generation",
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) {
      throw new Error("expected OpenRouter catalog row");
    }
    expectRecordFields(row, {
      kind: "video_generation",
      provider: "openrouter",
      model: "google/veo-3.1",
      label: "Veo 3.1",
      source: "live",
    });
    const capabilities = requireRecord(row.capabilities, "catalog row capabilities");
    expectRecordFields(capabilities, {
      canonicalSlug: "google/veo-3.1",
      description: "Google video generation model",
      created: 1_700_000_000,
      pricingSkus: { generate: "0.50" },
      allowedPassthroughParameters: ["provider"],
      videoToVideo: { enabled: false },
    });
    expectRecordFields(capabilities.generate, {
      supportsAudio: true,
      supportedDurationSeconds: [5, 8],
      aspectRatios: ["16:9"],
      resolutions: ["720P"],
      sizes: ["1280x720"],
    });
    expectRecordFields(capabilities.imageToVideo, {
      enabled: true,
      maxInputImages: 2,
    });
  });

  it("does not cache a malformed OpenRouter video catalog envelope", async () => {
    fetchWithTimeoutGuardedMock
      .mockResolvedValueOnce(releasedJson({}))
      .mockResolvedValueOnce(catalogRows({ id: "google/veo-3.1", name: "Veo 3.1" }));

    const ctx = catalogContext({}, "k", "d");

    await expect(listOpenRouterVideoModelCatalog(ctx)).rejects.toThrow(
      /OpenRouter video models request failed.*malformed JSON response/,
    );
    await expect(listOpenRouterVideoModelCatalog(ctx)).resolves.toMatchObject([
      { model: "google/veo-3.1" },
    ]);
    expect(fetchWithTimeoutGuardedMock).toHaveBeenCalledTimes(2);
  });

  it("lets configured auth replace the OpenRouter catalog default", async () => {
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(releasedJson({ data: [] }));

    await listOpenRouterVideoModelCatalog(
      catalogContext(
        {
          models: {
            providers: {
              openrouter: {
                request: {
                  auth: {
                    mode: "authorization-bearer",
                    token: ["test", "auth"].join("-"),
                  },
                },
              },
            },
          },
        } as never,
        "key",
        "test-key",
      ),
    );

    const requestConfig = requireRecord(
      requireMockCallArg(resolveProviderHttpRequestConfigMock.mock.calls, 0, 0, "request config"),
      "request config",
    );
    expect(requireRecord(requestConfig.defaultHeaders, "default headers").Authorization).toBe(
      "Bearer test-key",
    );
    expect(requireFetchCallHeaders(0).get("authorization")).toBe("Bearer test-auth");
  });

  it("keys live OpenRouter video catalog cache by request policy", async () => {
    fetchWithTimeoutGuardedMock
      .mockResolvedValueOnce(catalogRows({ id: "google/veo-3.1-fast", name: "Veo first policy" }))
      .mockResolvedValueOnce(
        catalogRows({ id: "google/veo-3.1-quality", name: "Veo second policy" }),
      );

    const firstRows = await listOpenRouterVideoModelCatalog(
      requestCatalogContext({
        allowPrivateNetwork: true,
        headers: { "X-OpenRouter-Policy": "first" },
      }),
    );
    const secondRows = await listOpenRouterVideoModelCatalog(
      requestCatalogContext({
        allowPrivateNetwork: false,
        headers: { "X-OpenRouter-Policy": "second" },
      }),
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

    await expect(
      listOpenRouterVideoModelCatalog(
        catalogContext(
          {
            models: {
              providers: {
                openrouter: {
                  baseUrl: "https://custom.openrouter.test/openrouter/api/v1",
                },
              },
            },
          } as never,
          "OPENROUTER_API_KEY",
          "resolved-openrouter-key",
        ),
      ),
    ).rejects.toThrow(
      "OpenRouter video models request failed: JSON response exceeds 16777216 bytes",
    );
    expect(oversized.wasCanceled()).toBe(true);
    expect(oversized.release).toHaveBeenCalledOnce();
  });

  it("skips live OpenRouter video catalog discovery without an API key", async () => {
    await expect(
      listOpenRouterVideoModelCatalog({
        config: {},
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
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(
      catalogRows(
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
      ),
    );

    const provider = buildOpenRouterVideoGenerationProvider();
    const capabilities = await provider.resolveModelCapabilities?.({
      provider: "openrouter",
      model,
      cfg: videoConfig(requestOverrides),
      timeoutMs: 12_345,
    });

    expect(
      requireRecord(callArg(resolveApiKeyForProviderMock.mock.calls), "API key request").provider,
    ).toBe("openrouter");
    expectOpenRouterFetchCall(0, `${customBaseUrl}/videos/models`, "models");
    expectRecordFields(callArg(resolveProviderHttpRequestConfigMock.mock.calls), {
      provider: "openrouter",
      capability: "video",
      baseUrl: "https://custom.openrouter.test/openrouter/api/v1",
      request: requestOverrides,
    });
    expect(requireFetchCallHeaders(0).get("x-openrouter-capabilities")).toBe("enabled");
    expect(requireFetchGuardOptions(0).ssrfPolicy).toEqual({ allowPrivateNetwork: true });
    expect(callArg(fetchWithTimeoutGuardedMock.mock.calls, 0, 2)).toBe(12_345);
    expect(callArg(fetchWithTimeoutGuardedMock.mock.calls, 0, 3)).toBeTypeOf("function");
    if (!found) {
      expect(capabilities).toBeUndefined();
      return;
    }
    const resolvedCapabilities = requireRecord(capabilities, "resolved capabilities");
    expect(resolvedCapabilities.providerOptions).toEqual({
      callback_url: "string",
      seed: "number",
    });
    expectRecordFields(resolvedCapabilities.generate, {
      supportsAudio: false,
      supportedDurationSeconds: [5],
      resolutions: ["720P"],
    });
  });

  it.each([
    { durationSeconds: 7, hint: undefined, expected: 8 },
    { durationSeconds: 5, hint: [5], expected: 5 },
    { durationSeconds: 5, hint: [], expected: 6 },
  ])(
    "normalizes duration $durationSeconds with hint $hint to $expected",
    async ({ durationSeconds, hint, expected }) => {
      completeVideo();

      await generateVideo({
        prompt: "A brushed steel logo rotates against a clean white backdrop",
        durationSeconds,
        [SUPPORTED_DURATIONS_HINT]: hint,
      });

      expect(requireRecord(requirePostJsonParams().body, "OpenRouter request body").duration).toBe(
        expected,
      );
    },
  );

  it("submits OpenRouter video jobs, polls completion, and downloads the result", async () => {
    postJsonRequestMock.mockResolvedValue(jobResponse({ status: "in_progress" }));
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
      proxy: { mode: "explicit-proxy", url: "https://proxy.example" },
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
      cfg: videoConfig(requestOverrides, generationBaseUrl),
    });

    expect(
      requireRecord(callArg(resolveApiKeyForProviderMock.mock.calls), "API key request").provider,
    ).toBe("openrouter");
    expectRecordFields(callArg(resolveProviderHttpRequestConfigMock.mock.calls), {
      provider: "openrouter",
      capability: "video",
      baseUrl: "https://custom.openrouter.test/api/v1",
      allowPrivateNetwork: false,
      request: requestOverrides,
    });
    const postParams = requirePostJsonParams();
    expect(postParams.url).toBe("https://custom.openrouter.test/api/v1/videos");
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
    expectOpenRouterFetchCall(0, `${generationBaseUrl}/videos/job-123`, "status");
    expect(requireFetchCallHeaders(0).get("authorization")).toBe("Bearer openrouter-key");
    expectOpenRouterFetchCall(1, `${generationBaseUrl}/videos/job-123`, "status");
    expectOpenRouterFetchCall(2, `${generationBaseUrl}/videos/job-123/content?index=0`, "download");
    expect(requireFetchCallHeaders(2).get("authorization")).toBe("Bearer openrouter-key");
    expect(waitProviderOperationPollIntervalMock).toHaveBeenCalledOnce();
    const { video, buffer } = requireGeneratedVideoBuffer(result);
    expect(buffer.toString()).toBe("mp4-bytes");
    expect(video.mimeType).toBe("video/mp4");
    expect(result.metadata).toEqual({
      jobId: "job-123",
      status: "completed",
      generationId: "gen-123",
      usage: { cost: 0.25, is_byok: false },
    });
  });

  it("returns unsigned URL-only videos when downloads exceed the configured media cap", async () => {
    postJsonRequestMock.mockResolvedValue(
      releasedJson({
        id: "job-123",
        polling_url: "/api/v1/videos/job-123",
        status: "completed",
        unsigned_urls: ["https://cdn.openrouter.test/video.mp4"],
      }),
    );
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(
      releasedVideo({ contentType: "video/mp4", bytes: "too-large" }),
    );

    const result = await generateVideo({
      prompt: "A glass cube reflects a neon skyline",
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
    await expect(
      generateVideo({
        prompt: "A glass cube reflects a neon skyline",
        providerOptions: { seed: 42.9 },
      }),
    ).rejects.toThrow("OpenRouter video seed must be an integer");

    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it.each([
    ["array", () => releasedJson([])],
    ["HTML", () => releasedResponse("<html></html>", "text/html")],
  ] as const)("wraps malformed successful %s submit responses", async (_name, response) => {
    postJsonRequestMock.mockResolvedValue(response());
    await expect(generateVideo({ prompt: "bad shape" })).rejects.toThrow(
      "OpenRouter video generation response malformed",
    );
  });

  it("bounds oversized successful OpenRouter submit responses", async () => {
    const oversized = releasedOversizedJsonStream();
    postJsonRequestMock.mockResolvedValue(oversized);

    await expect(generateVideo({ prompt: "oversized body" })).rejects.toThrow(
      "OpenRouter video generation: JSON response exceeds 16777216 bytes",
    );
    expect(oversized.wasCanceled()).toBe(true);
  });

  it.each([
    {
      status: "nearly_done",
      error: undefined,
      expected: "OpenRouter video generation response malformed",
    },
    {
      status: "failed",
      error: "  ",
      expected: "OpenRouter video generation failed",
    },
  ])(
    "rejects poll status $status without waiting for timeout",
    async ({ status, error, expected }) => {
      postJsonRequestMock.mockResolvedValue(jobResponse({ status: "pending" }));
      fetchWithTimeoutGuardedMock.mockResolvedValueOnce(
        releasedJson({
          id: "job-123",
          status,
          error,
        }),
      );

      await expect(generateVideo({ prompt: "bad status" })).rejects.toThrow(expected);
      expect(waitProviderOperationPollIntervalMock).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed OpenRouter completed output URL arrays", async () => {
    postJsonRequestMock.mockResolvedValue(
      jobResponse({
        status: "completed",
        unsigned_urls: { 0: "/api/v1/videos/job-123/content?index=0" },
      }),
    );

    await expect(generateVideo({ prompt: "bad urls" })).rejects.toThrow(
      "OpenRouter video generation response malformed",
    );
  });

  it("does not forward auth headers to cross-origin polling URLs", async () => {
    postJsonRequestMock.mockResolvedValue(
      jobResponse({
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

    await generateVideo({ prompt: "A gentle camera pan across a neon reef" });

    expectOpenRouterFetchCall(0, "https://polling.example.test/videos/job-123", "status");
    expect(requireFetchCallHeaders(0).get("authorization")).toBeNull();
    expectOpenRouterFetchCall(1, "https://cdn.openrouter.test/video.mp4", "download");
    expect(requireFetchCallHeaders(1).get("authorization")).toBeNull();
  });

  it("falls back to the documented content endpoint when a completed job has no output URL", async () => {
    postJsonRequestMock.mockResolvedValue(
      jobResponse({
        polling_url: "https://openrouter.ai/api/v1/videos/job-123",
        status: "completed",
      }),
    );
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(
      releasedVideo({ contentType: "video/webm", bytes: "webm-bytes" }),
    );

    const result = await generateVideo({ prompt: "A tiny robot watering a bonsai" });

    expectOpenRouterFetchCall(
      0,
      "https://openrouter.ai/api/v1/videos/job-123/content?index=0",
      "download",
    );
    const { video, buffer } = requireGeneratedVideoBuffer(result);
    expect(buffer.toString()).toBe("webm-bytes");
    expect(video.fileName).toBe("video-1.webm");
  });

  it("rejects video reference inputs", async () => {
    await expect(
      generateVideo({
        prompt: "remix this clip",
        inputVideos: [{ url: "https://example.com/source.mp4", mimeType: "video/mp4" }],
      }),
    ).rejects.toThrow("does not support video reference inputs");
  });
});

describe("openrouter generated video download", () => {
  afterEach(resetVideoMocks);

  it.each([
    {
      name: "JSON error",
      contentType: "application/json",
      bytes: '{"error":"denied"}',
    },
    {
      name: "problem JSON",
      contentType: "application/problem+json",
      bytes: '{"title":"denied"}',
    },
    {
      name: "HTML",
      contentType: "text/html; charset=utf-8",
      bytes: "<html>sign in</html>",
    },
    { name: "empty video", contentType: "video/mp4", bytes: "" },
  ])(
    "rejects a successful $name response as a downloaded OpenRouter video",
    async ({ contentType, bytes }) => {
      postJsonRequestMock.mockResolvedValue(
        releasedJson({
          id: "job-123",
          polling_url: "/api/v1/videos/job-123",
          status: "completed",
          unsigned_urls: ["https://cdn.openrouter.test/video.mp4"],
        }),
      );
      const download = releasedVideo({ contentType, bytes });
      fetchWithTimeoutGuardedMock.mockResolvedValueOnce(download);

      await expect(
        generateVideo({
          prompt: "A glass cube reflects a neon skyline",
        }),
      ).rejects.toThrow("OpenRouter generated video download: malformed video response");

      expect(download.release).toHaveBeenCalledTimes(1);
    },
  );
});

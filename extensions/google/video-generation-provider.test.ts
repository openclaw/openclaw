// Google tests cover video generation provider plugin behavior (Gemini Omni
// Flash through the Interactions API).
import { ApiError } from "@google/genai";
import { formatErrorMessage, toStringifiedError } from "openclaw/plugin-sdk/error-runtime";
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { oversizedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { afterAll, afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";

const { createGoogleGenAIMock, interactionsCreateMock } = vi.hoisted(() => {
  const interactionsCreateMockLocal = vi.fn();
  const createGoogleGenAIMockLocal = vi.fn(() => {
    return {
      interactions: {
        create: interactionsCreateMockLocal,
      },
    };
  });
  return {
    createGoogleGenAIMock: createGoogleGenAIMockLocal,
    interactionsCreateMock: interactionsCreateMockLocal,
  };
});

vi.mock("./google-genai-runtime.js", () => ({
  createGoogleGenAI: createGoogleGenAIMock,
}));

import * as providerAuth from "openclaw/plugin-sdk/provider-auth";
import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { generateVideo as generateRuntimeVideo } from "openclaw/plugin-sdk/video-generation-runtime";
import * as googleBase64 from "./base64.js";
import { googleVideoGenerationProvider } from "./video-generation-provider.js";

const GOOGLE_FILES_BASE = "https://generativelanguage.googleapis.com/v1beta/files";

function mockGoogleApiKeyAuth(apiKey = "google-key") {
  vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
    apiKey,
    source: "env",
    mode: "api-key",
  });
}

function generateVideo(overrides: Partial<VideoGenerationRequest> = {}) {
  return googleVideoGenerationProvider.generateVideo({
    provider: "google",
    model: "gemini-omni-1.1-flash",
    prompt: "A tiny robot watering a windowsill garden",
    cfg: {},
    ...overrides,
  });
}

function completedInteraction(
  outputVideo: { data?: string; uri?: string; mime_type?: string } | undefined,
  fields: { id?: string; status?: string } = {},
): Record<string, unknown> {
  return {
    id: "v1_interaction-123",
    status: "completed",
    ...(outputVideo === undefined ? {} : { output_video: outputVideo }),
    ...fields,
  };
}

type MockWithCalls = {
  mock: { calls: unknown[][] };
};

function firstObjectArg(mock: MockWithCalls): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected first mock call to receive an object argument");
  }
  const value = call[0];
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected first mock call to receive an object argument");
  }
  return value as Record<string, unknown>;
}

function recordField(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${field} to be an object`);
  }
  return value as Record<string, unknown>;
}

function firstGoogleClientHttpOptions(): Record<string, unknown> {
  return recordField(firstObjectArg(createGoogleGenAIMock).httpOptions, "httpOptions");
}

function requireFetchCall(
  fetchMock: ReturnType<typeof vi.fn>,
  index: number,
): [RequestInfo | URL, RequestInit | undefined] {
  const call = fetchMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected Google video fetch call ${index}`);
  }
  return call as [RequestInfo | URL, RequestInit | undefined];
}

function fetchInputUrl(fetchMock: ReturnType<typeof vi.fn>, index: number): string {
  const [input] = requireFetchCall(fetchMock, index);
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

let ssrfMock: { mockRestore: () => void } | undefined;

describe("google video generation provider", () => {
  beforeEach(() => {
    ssrfMock = mockPinnedHostnameResolution();
  });

  afterEach(() => {
    ssrfMock?.mockRestore();
    ssrfMock = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    interactionsCreateMock.mockReset();
    createGoogleGenAIMock.mockClear();
    vi.useRealTimers();
  });

  afterAll(() => {
    vi.doUnmock("./google-genai-runtime.js");
    vi.resetModules();
  });

  it("declares explicit mode capabilities with native audio output", () => {
    const provider = googleVideoGenerationProvider;
    expectExplicitVideoGenerationCapabilities(provider);
    expect(provider.capabilities.generate?.supportsAudio).toBe(true);
    expect(provider.capabilities.imageToVideo?.supportsAudio).toBe(true);
    expect(provider.capabilities.videoToVideo?.supportsAudio).toBe(true);
  });

  it("advertises Gemini Omni Flash as the only Google video model", () => {
    const provider = googleVideoGenerationProvider;
    expect(provider.defaultModel).toBe("gemini-omni-1.1-flash");
    expect(provider.models).toEqual(["gemini-omni-1.1-flash"]);
  });

  it("rejects a duration that rounds to zero before submission", async () => {
    mockGoogleApiKeyAuth();
    await expect(generateVideo({ durationSeconds: 0.4 })).rejects.toThrow(
      "durationSeconds must be a positive duration",
    );
    expect(interactionsCreateMock).not.toHaveBeenCalled();
    expect(createGoogleGenAIMock).not.toHaveBeenCalled();
  });

  it("rejects more than two input images before submission", async () => {
    mockGoogleApiKeyAuth();
    await expect(
      generateVideo({
        inputImages: [
          { buffer: Buffer.from("a") },
          { buffer: Buffer.from("b") },
          { buffer: Buffer.from("c") },
        ],
      }),
    ).rejects.toThrow("Google video generation supports at most two input images.");
    expect(interactionsCreateMock).not.toHaveBeenCalled();
    expect(createGoogleGenAIMock).not.toHaveBeenCalled();
  });

  it("rejects more than one input video before submission", async () => {
    mockGoogleApiKeyAuth();
    await expect(
      generateVideo({
        inputVideos: [{ buffer: Buffer.from("a") }, { buffer: Buffer.from("b") }],
      }),
    ).rejects.toThrow("Google video generation supports at most one input video.");
    expect(interactionsCreateMock).not.toHaveBeenCalled();
    expect(createGoogleGenAIMock).not.toHaveBeenCalled();
  });

  it("routes the default video model through the Omni Interactions transport", async () => {
    mockGoogleApiKeyAuth();
    const videoBytes = Buffer.from([0xfb, 0xff, 0x6d, 0x70, 0x34]);
    interactionsCreateMock.mockResolvedValue(
      completedInteraction({
        data: videoBytes.toString("base64"),
        mime_type: "video/mp4",
      }),
    );
    const result = await generateVideo({ model: undefined });

    expect(interactionsCreateMock).toHaveBeenCalledTimes(1);
    const request = firstObjectArg(interactionsCreateMock);
    expect(request.model).toBe("gemini-omni-1.1-flash");
    expect(request.input).toEqual([
      { type: "text", text: "A tiny robot watering a windowsill garden" },
    ]);
    expect(request.response_format).toEqual({ type: "video", delivery: "uri" });
    expect(request.background).toBe(false);
    expect(request.store).toBe(false);
    expect(request.stream).toBe(false);
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.buffer).toEqual(videoBytes);
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    expect(result.videos[0]?.fileName).toBe("video-1.mp4");
    expect(result.model).toBe("gemini-omni-1.1-flash");
    expect(result.metadata).toEqual({ interactionId: "v1_interaction-123" });
    const clientOptions = firstObjectArg(createGoogleGenAIMock);
    expect(clientOptions.apiKey).toBe("google-key");
    const httpOptions = recordField(clientOptions.httpOptions, "httpOptions");
    expect(httpOptions).not.toHaveProperty("baseUrl");
    expect(httpOptions).not.toHaveProperty("apiVersion");
  });

  it.each([
    {
      name: "aspect ratio and resolution",
      input: { aspectRatio: "9:16", resolution: "1080P" },
      expected: { aspect_ratio: "9:16", resolution: "1080p" },
    },
    {
      name: "4K resolution label",
      input: { resolution: "4K" },
      expected: { resolution: "4k" },
    },
    {
      name: "360p resolution label",
      input: { resolution: "360P" },
      expected: { resolution: "360p" },
    },
    {
      name: "4K landscape size",
      input: { size: "3840x2160" },
      expected: { aspect_ratio: "16:9", resolution: "4k" },
    },
    {
      name: "720p landscape size",
      input: { size: "1280x720" },
      expected: { aspect_ratio: "16:9", resolution: "720p" },
    },
    {
      name: "360p landscape size",
      input: { size: "640x360" },
      expected: { aspect_ratio: "16:9", resolution: "360p" },
    },
    {
      name: "portrait size",
      input: { size: "720x1280" },
      expected: { aspect_ratio: "9:16", resolution: "720p" },
    },
  ])("maps $name onto the video response format", async ({ input, expected }) => {
    mockGoogleApiKeyAuth();
    interactionsCreateMock.mockResolvedValue(completedInteraction({ data: "b3V0" }));

    await generateVideo(input);

    const request = firstObjectArg(interactionsCreateMock);
    expect(request.response_format).toEqual({
      type: "video",
      delivery: "uri",
      ...expected,
    });
  });

  it("does not forward a duration to the Omni Interactions API", async () => {
    mockGoogleApiKeyAuth();
    interactionsCreateMock.mockResolvedValue(completedInteraction({ data: "b3V0" }));

    await generateVideo({ durationSeconds: 8 });

    const request = firstObjectArg(interactionsCreateMock);
    expect(request.response_format).not.toHaveProperty("duration");
    expect(request).not.toHaveProperty("duration");
    expect(request).not.toHaveProperty("generation_config");
  });

  it.each(["google/gemini-omni-1.1-flash", "google/models/gemini-omni-1.1-flash"])(
    "normalizes %s for submission while preserving the result model",
    async (model) => {
      mockGoogleApiKeyAuth();
      interactionsCreateMock.mockResolvedValue(
        completedInteraction({ data: Buffer.from("mp4").toString("base64") }),
      );
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await generateVideo({ model });

      expect(interactionsCreateMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ model: model.slice("google/".length) }),
        { maxRetries: 0 },
      );
      expect(result.model).toBe(model);
      expect(result.videos[0]?.buffer).toEqual(Buffer.from("mp4"));
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "single image default MIME",
      input: { inputImages: [{ buffer: Buffer.from([0, 255, 128]) }] },
      contents: [
        { type: "image", data: "AP+A", mime_type: "image/png" },
        { type: "text", text: "A tiny robot watering a windowsill garden" },
      ],
    },
    {
      name: "two images with explicit MIME",
      input: {
        inputImages: [
          { buffer: Buffer.from([0, 255, 128]), mimeType: " image/WebP " },
          { buffer: Buffer.from([1, 2, 3]) },
        ],
      },
      contents: [
        { type: "image", data: "AP+A", mime_type: "image/WebP" },
        { type: "image", data: "AQID", mime_type: "image/png" },
        { type: "text", text: "A tiny robot watering a windowsill garden" },
      ],
    },
    {
      name: "video default MIME",
      input: { inputVideos: [{ buffer: Buffer.from([0, 255, 128]), mimeType: " " }] },
      contents: [
        { type: "video", data: "AP+A", mime_type: "video/mp4" },
        { type: "text", text: "A tiny robot watering a windowsill garden" },
      ],
    },
    {
      name: "video empty buffer",
      input: { inputVideos: [{ buffer: Buffer.alloc(0), mimeType: " video/WebM " }] },
      contents: [
        { type: "video", data: "", mime_type: "video/WebM" },
        { type: "text", text: "A tiny robot watering a windowsill garden" },
      ],
    },
    {
      name: "URL-only image",
      input: { inputImages: [{ url: "https://example.com/reference.png" }] },
      contents: [{ type: "text", text: "A tiny robot watering a windowsill garden" }],
    },
  ])("encodes $name as interaction contents", async ({ input, contents }) => {
    mockGoogleApiKeyAuth();
    interactionsCreateMock.mockResolvedValue(completedInteraction({ data: "b3V0" }));

    const result = await generateVideo(input);

    expect(interactionsCreateMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ input: contents }),
      { maxRetries: 0 },
    );
    expect(result.videos[0]?.buffer).toEqual(Buffer.from("out"));
  });

  it("accepts image and video reference inputs together", async () => {
    mockGoogleApiKeyAuth();
    interactionsCreateMock.mockResolvedValue(completedInteraction({ data: "b3V0" }));

    const result = await generateVideo({
      prompt: "Extend this clip: keep the motion coherent",
      inputImages: [{ buffer: Buffer.from("img"), mimeType: "image/png" }],
      inputVideos: [{ buffer: Buffer.from("vid"), mimeType: "video/mp4" }],
    });

    expect(interactionsCreateMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        input: [
          { type: "image", data: Buffer.from("img").toString("base64"), mime_type: "image/png" },
          { type: "video", data: Buffer.from("vid").toString("base64"), mime_type: "video/mp4" },
          { type: "text", text: "Extend this clip: keep the motion coherent" },
        ],
      }),
      { maxRetries: 0 },
    );
    expect(result.videos[0]?.buffer).toEqual(Buffer.from("out"));
  });

  it("admits mixed image and video references through the shared runtime", async () => {
    mockGoogleApiKeyAuth();
    vi.spyOn(providerAuth, "isProviderApiKeyConfiguredAsync").mockResolvedValue(true);
    interactionsCreateMock.mockResolvedValue(completedInteraction({ data: "b3V0" }));

    const result = await generateRuntimeVideo(
      {
        cfg: {},
        prompt: "Extend this clip: keep the motion coherent",
        inputImages: [{ buffer: Buffer.from("img"), mimeType: "image/png" }],
        inputVideos: [{ buffer: Buffer.from("vid"), mimeType: "video/mp4" }],
      },
      {
        getProvider: (id) => (id === "google" ? googleVideoGenerationProvider : undefined),
        listProviders: () => [googleVideoGenerationProvider],
        getProviderEnvVars: () => [],
        log: { debug: vi.fn(), warn: vi.fn() },
      },
    );

    expect(result.provider).toBe("google");
    expect(result.videos[0]?.buffer).toEqual(Buffer.from("out"));
  });

  it("keeps a stored retired Veo model pin loadable and recovers via the new default", async () => {
    mockGoogleApiKeyAuth();
    vi.spyOn(providerAuth, "isProviderApiKeyConfiguredAsync").mockResolvedValue(true);
    const warn = vi.fn();
    interactionsCreateMock.mockImplementation(async (request: { model?: string }) => {
      if (request?.model?.includes("veo-")) {
        throw new ApiError({ status: 404, message: "model not found: retired" });
      }
      return completedInteraction({ data: "b3V0" });
    });

    // Stored user data (mediaModels.video pinned to a retired Veo id) still
    // loads after the upgrade: the pin is submitted as-is (single-shot), the
    // server-side rejection is surfaced with the model ref, and the shared
    // runtime's auto provider fallback recovers with the new default model.
    const result = await generateRuntimeVideo(
      {
        cfg: {
          agents: {
            defaults: {
              mediaModels: { video: "google/veo-3.1-fast-generate-preview" },
            },
          },
        },
        prompt: "A tiny robot watering a windowsill garden",
      },
      {
        getProvider: (id) => (id === "google" ? googleVideoGenerationProvider : undefined),
        listProviders: () => [googleVideoGenerationProvider],
        getProviderEnvVars: () => [],
        log: { debug: vi.fn(), warn },
      },
    );

    expect(interactionsCreateMock).toHaveBeenCalledTimes(2);
    expect(interactionsCreateMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ model: "veo-3.1-fast-generate-preview" }),
      { maxRetries: 0 },
    );
    expect(interactionsCreateMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ model: "gemini-omni-1.1-flash" }),
      { maxRetries: 0 },
    );
    expect(result.provider).toBe("google");
    expect(result.videos[0]?.buffer).toEqual(Buffer.from("out"));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("google/veo-3.1-fast-generate-preview"),
    );
  });

  it("disables SDK-internal retries for the paid generation creation", async () => {
    mockGoogleApiKeyAuth();
    interactionsCreateMock.mockResolvedValue(completedInteraction({ data: "b3V0" }));

    await generateVideo();

    expect(interactionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-omni-1.1-flash" }),
      { maxRetries: 0 },
    );
  });

  it.each([
    ["non-canonical pad bits", "ZE=="],
    ["mixed alphabet", "aGVsbG8+_"],
  ])("rejects %s in inline video bytes", async (_scenario, data) => {
    mockGoogleApiKeyAuth();
    interactionsCreateMock.mockResolvedValue(
      completedInteraction({ data, mime_type: "video/mp4" }),
    );

    await expect(generateVideo()).rejects.toThrow(
      "Google video generation returned malformed base64 video data",
    );
  });

  it("rejects oversized inline video before canonicalization or decoding", async () => {
    mockGoogleApiKeyAuth();
    interactionsCreateMock.mockResolvedValue(
      completedInteraction({ data: " -_9tcDQ\n", mime_type: "video/mp4" }),
    );
    const canonicalize = vi.spyOn(googleBase64, "canonicalizeGoogleProviderBase64");
    const decode = vi.spyOn(Buffer, "from");
    await expect(
      generateVideo({
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
      }),
    ).rejects.toThrow("Google generated video download exceeds 1 bytes");
    expect(canonicalize).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalledWith(expect.any(String), "base64");
  });

  it.each([
    { data: "YQ==", expected: [0x61], maxBytes: 1 },
    { data: " -_8\n", expected: [0xfb, 0xff], maxBytes: 2 },
  ])("accepts inline video exactly at the $maxBytes-byte cap", async (fixture) => {
    mockGoogleApiKeyAuth();
    interactionsCreateMock.mockResolvedValue(completedInteraction({ data: fixture.data }));

    const result = await generateVideo({
      cfg: { agents: { defaults: { mediaMaxMb: fixture.maxBytes / (1024 * 1024) } } },
    });

    expect(result.videos[0]?.buffer).toEqual(Buffer.from(fixture.expected));
  });

  it.each([
    {
      name: "strips /v1beta suffix from configured baseUrl before passing to GoogleGenAI SDK",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      expectedBaseUrl: "https://generativelanguage.googleapis.com",
      prompt: "A tiny robot watering a windowsill garden",
    },
    {
      name: "does NOT strip /v1beta when it appears mid-path (end-anchor proof)",
      baseUrl: "https://proxy.example.com/v1beta/route",
      expectedBaseUrl: "https://proxy.example.com/v1beta/route",
      prompt: "test",
    },
    {
      name: "passes baseUrl unchanged when no /v1beta suffix is present",
      baseUrl: "https://generativelanguage.googleapis.com",
      expectedBaseUrl: "https://generativelanguage.googleapis.com",
      prompt: "test",
    },
  ])("$name", async ({ baseUrl, expectedBaseUrl, prompt }) => {
    mockGoogleApiKeyAuth();
    interactionsCreateMock.mockResolvedValue(
      completedInteraction({ data: Buffer.from("mp4").toString("base64") }),
    );

    await generateVideo({
      prompt,
      cfg: { models: { providers: { google: { baseUrl, models: [] } } } },
    });

    expect(firstGoogleClientHttpOptions().baseUrl).toBe(expectedBaseUrl);
  });

  it("reports a completed interaction without video output", async () => {
    mockGoogleApiKeyAuth();
    interactionsCreateMock.mockResolvedValue(completedInteraction(undefined));
    const fetchMock = vi.fn(() => {
      throw new Error("Unexpected second generation request");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateVideo()).rejects.toThrow(
      "Google video generation response missing generated videos",
    );

    expect(interactionsCreateMock).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads uri-delivered videos through the Files API after the file becomes ACTIVE", async () => {
    mockGoogleApiKeyAuth();
    interactionsCreateMock.mockResolvedValue(
      completedInteraction({ uri: "files/generated-video", mime_type: "video/mp4" }),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ name: "files/generated-video", state: "ACTIVE" }))
      .mockResolvedValueOnce(
        new Response("uri-video", {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "video/mp4" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateVideo();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchInputUrl(fetchMock, 0)).toBe(`${GOOGLE_FILES_BASE}/generated-video`);
    expect(fetchInputUrl(fetchMock, 1)).toBe(
      `${GOOGLE_FILES_BASE}/generated-video:download?alt=media&key=google-key`,
    );
    expect(result.videos[0]?.buffer).toEqual(Buffer.from("uri-video"));
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    expect(result.videos[0]?.fileName).toBe("video-1.mp4");
  });

  it("downloads full-url uri-delivered videos after polling the file state", async () => {
    mockGoogleApiKeyAuth();
    interactionsCreateMock.mockResolvedValue(
      completedInteraction({
        uri: "https://generativelanguage.googleapis.com/v1beta/files/full-uri-video:download?alt=media",
        mime_type: "video/mp4",
      }),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ name: "files/full-uri-video", state: "ACTIVE" }))
      .mockResolvedValueOnce(
        new Response("full-uri-video", {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "video/mp4" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateVideo();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchInputUrl(fetchMock, 0)).toBe(`${GOOGLE_FILES_BASE}/full-uri-video`);
    expect(fetchInputUrl(fetchMock, 1)).toBe(
      `${GOOGLE_FILES_BASE}/full-uri-video:download?alt=media&key=google-key`,
    );
    expect(result.videos[0]?.buffer).toEqual(Buffer.from("full-uri-video"));
  });

  it("polls until a uri-delivered file becomes ACTIVE", async () => {
    vi.useFakeTimers();
    mockGoogleApiKeyAuth();
    interactionsCreateMock.mockResolvedValue(
      completedInteraction({ uri: "files/generated-video" }),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ state: "PROCESSING" }))
      .mockResolvedValueOnce(Response.json({ state: "ACTIVE" }))
      .mockResolvedValueOnce(
        new Response("polled-video", {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "video/mp4" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const resultPromise = generateVideo();
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await resultPromise;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchInputUrl(fetchMock, 0)).toBe(`${GOOGLE_FILES_BASE}/generated-video`);
    expect(fetchInputUrl(fetchMock, 1)).toBe(`${GOOGLE_FILES_BASE}/generated-video`);
    expect(fetchInputUrl(fetchMock, 2)).toBe(
      `${GOOGLE_FILES_BASE}/generated-video:download?alt=media&key=google-key`,
    );
    expect(result.videos[0]?.buffer).toEqual(Buffer.from("polled-video"));
  });

  it("rejects when a uri-delivered file fails processing", async () => {
    mockGoogleApiKeyAuth();
    interactionsCreateMock.mockResolvedValue(
      completedInteraction({ uri: "files/generated-video" }),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ name: "files/generated-video", state: "FAILED" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateVideo()).rejects.toThrow("Google generated video file processing failed");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retries transient file-state poll failures with empty bodies", async () => {
    vi.useFakeTimers();
    mockGoogleApiKeyAuth();
    interactionsCreateMock.mockResolvedValue(
      completedInteraction({ uri: "files/generated-video" }),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 503, statusText: "Service Unavailable" }))
      .mockResolvedValueOnce(Response.json({ state: "PROCESSING" }))
      .mockResolvedValueOnce(Response.json({ state: "ACTIVE" }))
      .mockResolvedValueOnce(
        new Response("rest-video", {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "video/mp4" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const resultPromise = generateVideo();
    await vi.advanceTimersByTimeAsync(10_250);
    const result = await resultPromise;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchInputUrl(fetchMock, 0)).toBe(`${GOOGLE_FILES_BASE}/generated-video`);
    expect(fetchInputUrl(fetchMock, 1)).toBe(`${GOOGLE_FILES_BASE}/generated-video`);
    expect(fetchInputUrl(fetchMock, 2)).toBe(`${GOOGLE_FILES_BASE}/generated-video`);
    expect(fetchInputUrl(fetchMock, 3)).toBe(
      `${GOOGLE_FILES_BASE}/generated-video:download?alt=media&key=google-key`,
    );
    expect(result.videos[0]?.buffer).toEqual(Buffer.from("rest-video"));
  });

  it.each(["create", "file-poll", "download"] as const)(
    "redacts the active credential from %s diagnostics",
    async (path) => {
      const credential = "opaque-video-key42";
      const diagnostic = `provider diagnostic ${credential}`;
      mockGoogleApiKeyAuth(credential);
      if (path === "create") {
        interactionsCreateMock.mockRejectedValue(
          new ApiError({ status: 403, message: diagnostic }),
        );
      } else {
        interactionsCreateMock.mockResolvedValue(
          completedInteraction({ uri: "files/generated-video" }),
        );
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: RequestInfo | URL) => {
            const requestUrl =
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (path === "download" && !requestUrl.includes(":download")) {
              // The download row must reach the failing download: the first
              // file-state poll succeeds so only the download stage fails.
              return Response.json({ state: "ACTIVE" });
            }
            if (path === "file-poll") {
              return new Response(null, { status: 403, statusText: diagnostic });
            }
            return new Response("video-bytes", {
              status: 403,
              statusText: diagnostic,
              headers: { "content-type": "video/mp4" },
            });
          }),
        );
      }

      const error: unknown = await generateVideo().catch((cause: unknown) => cause);
      assert(error instanceof Error);
      expect(formatErrorMessage(error)).not.toContain(credential);
      expect(error.message).toContain("provider diagnostic");
      if (path === "create") {
        expect(error).toMatchObject({ name: "ApiError", status: 403 });
      } else if (path === "file-poll") {
        expect(error).toMatchObject({ status: 403, statusCode: 403 });
      } else {
        // Download-stage failures surface as a plain provider error whose
        // message carries the redacted diagnostic.
        expect(error.message).toContain("Failed to download Google generated video: 403");
        expect(error).not.toHaveProperty("status");
      }
    },
  );

  it.each(["headers", "body"] as const)(
    "bounds file-state polling %s waits by the operation deadline",
    async (phase) => {
      vi.useFakeTimers();
      mockGoogleApiKeyAuth();
      interactionsCreateMock.mockResolvedValue(
        completedInteraction({ uri: "files/generated-video" }),
      );
      const started = Promise.withResolvers<void>();
      const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal;
        if (!signal) {
          throw new Error("expected request cancellation signal");
        }
        if (phase === "headers") {
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(toStringifiedError(signal.reason)), {
              once: true,
            });
            started.resolve();
          });
        }
        const response = new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              signal.addEventListener("abort", () => controller.error(signal.reason), {
                once: true,
              });
            },
          }),
        );
        started.resolve();
        return Promise.resolve(response);
      });
      vi.stubGlobal("fetch", fetchMock);
      // The file-state poll stage retries one transient timeout attempt; on the
      // retry the already-exhausted deadline surfaces as the operation error.
      const rejection = expect(generateVideo({ timeoutMs: 1_000 })).rejects.toMatchObject({
        message: "Google video generation timed out after 1000ms",
      });
      await started.promise;
      await vi.advanceTimersByTimeAsync(2_500);
      await rejection;
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("bounds successful file-state JSON bodies instead of buffering the whole response", async () => {
    mockGoogleApiKeyAuth();
    interactionsCreateMock.mockResolvedValue(
      completedInteraction({ uri: "files/generated-video" }),
    );
    const streamed = oversizedJsonResponse({ chunkCount: 64, chunkSize: 1024 * 1024 });
    const fetchMock = vi.fn(async () => streamed.response);
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateVideo()).rejects.toThrow(
      "Google video operation response: JSON response exceeds 16777216 bytes",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(streamed.getReadCount()).toBeLessThan(64);
    expect(streamed.wasCanceled()).toBe(true);
  });

  it("reports malformed file-state JSON with a stable provider error", async () => {
    const credential = "opaque-video-key42";
    mockGoogleApiKeyAuth(credential);
    interactionsCreateMock.mockResolvedValue(
      completedInteraction({ uri: "files/generated-video" }),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(credential, { status: 200 })));

    const error: unknown = await generateVideo().catch((cause: unknown) => cause);
    assert(error instanceof Error);
    expect(error.message).toBe("Google video operation response: malformed JSON response");
    expect(formatErrorMessage(error)).not.toContain(credential);
    expect(error.cause).toBeUndefined();
  });

  it("rejects invalid UTF-8 in file-state JSON before parsing", async () => {
    mockGoogleApiKeyAuth();
    interactionsCreateMock.mockResolvedValue(
      completedInteraction({ uri: "files/generated-video" }),
    );
    const invalidUtf8Json = new Uint8Array([
      ...Buffer.from('{"state":"'),
      0xff,
      ...Buffer.from('"}'),
    ]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(invalidUtf8Json)));

    await expect(generateVideo()).rejects.toThrow(
      "Google video operation response: malformed JSON response",
    );
  });

  it("rejects uri-delivered downloads that exceed the configured media cap", async () => {
    mockGoogleApiKeyAuth();
    interactionsCreateMock.mockResolvedValue(
      completedInteraction({ uri: "files/generated-video" }),
    );
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          return Response.json({ state: "ACTIVE" });
        }
        return new Response("too-large", {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "video/mp4" },
        });
      }),
    );
    await expect(
      generateVideo({
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
      }),
    ).rejects.toThrow("Google generated video download exceeds 1 bytes");
  });

  it.each([
    { name: "JSON error", contentType: "application/json", body: '{"error":"denied"}' },
    { name: "problem JSON", contentType: "application/problem+json", body: '{"title":"denied"}' },
    { name: "HTML", contentType: "text/html; charset=utf-8", body: "<html>sign in</html>" },
    { name: "empty video", contentType: "video/mp4", body: "" },
  ])("rejects a successful $name video download response", async ({ contentType, body }) => {
    mockGoogleApiKeyAuth();
    interactionsCreateMock.mockResolvedValue(
      completedInteraction({ uri: "files/generated-video" }),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (typeof input === "string" && !input.includes(":download")) {
        return Response.json({ state: "ACTIVE" });
      }
      return new Response(body, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": contentType },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateVideo()).rejects.toThrow(
      "Google generated video download: malformed video response",
    );
  });

  it("preserves the video download error when a failed response has no body", async () => {
    mockGoogleApiKeyAuth();
    interactionsCreateMock.mockResolvedValue(
      completedInteraction({ uri: "files/generated-video" }),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (typeof input === "string" && !input.includes(":download")) {
        return Response.json({ state: "ACTIVE" });
      }
      return new Response(null, { status: 503, statusText: "Service Unavailable" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateVideo()).rejects.toThrow(
      "Failed to download Google generated video: 503 Service Unavailable",
    );
  });
});

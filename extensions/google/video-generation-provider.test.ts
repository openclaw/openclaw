// Google tests cover video generation provider plugin behavior.
import { ApiError, type Video } from "@google/genai";
import { formatErrorMessage, toStringifiedError } from "openclaw/plugin-sdk/error-runtime";
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { oversizedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { afterAll, afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";

const { createGoogleGenAIMock, downloadMock, generateVideosMock, getVideosOperationMock } =
  vi.hoisted(() => {
    const generateVideosMockLocal = vi.fn();
    const getVideosOperationMockLocal = vi.fn();
    const downloadMockLocal = vi.fn();
    const createGoogleGenAIMockLocal = vi.fn(() => {
      return {
        models: {
          generateVideos: generateVideosMockLocal,
        },
        operations: {
          getVideosOperation: getVideosOperationMockLocal,
        },
        files: {
          download: downloadMockLocal,
        },
      };
    });
    return {
      createGoogleGenAIMock: createGoogleGenAIMockLocal,
      downloadMock: downloadMockLocal,
      generateVideosMock: generateVideosMockLocal,
      getVideosOperationMock: getVideosOperationMockLocal,
    };
  });

vi.mock("./google-genai-runtime.js", () => ({
  createGoogleGenAI: createGoogleGenAIMock,
}));

import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import * as googleBase64 from "./base64.js";
import { googleVideoGenerationProvider } from "./video-generation-provider.js";

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
    model: "veo-3.1-fast-generate-preview",
    prompt: "A tiny robot watering a windowsill garden",
    cfg: {},
    ...overrides,
  });
}

function completedVideo(video: Video, fields: { name?: string } = {}) {
  return { done: true, ...fields, response: { generatedVideos: [{ video }] } };
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

function parseFetchJsonBody(fetchMock: ReturnType<typeof vi.fn>, index: number): unknown {
  const [, init] = requireFetchCall(fetchMock, index);
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error(`expected Google video fetch body ${index}`);
  }
  return JSON.parse(body) as unknown;
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
  it("rejects a duration that rounds to zero before submission", async () => {
    mockGoogleApiKeyAuth();
    await expect(generateVideo({ durationSeconds: 0.4 })).rejects.toThrow(
      "durationSeconds must be a positive duration",
    );
    expect(generateVideosMock).not.toHaveBeenCalled();
    expect(createGoogleGenAIMock).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    ssrfMock = mockPinnedHostnameResolution();
  });

  afterEach(() => {
    ssrfMock?.mockRestore();
    ssrfMock = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    downloadMock.mockReset();
    generateVideosMock.mockReset();
    getVideosOperationMock.mockReset();
    createGoogleGenAIMock.mockClear();
    vi.useRealTimers();
  });

  afterAll(() => {
    vi.doUnmock("./google-genai-runtime.js");
    vi.resetModules();
  });

  it("declares explicit mode capabilities", () => {
    const provider = googleVideoGenerationProvider;
    expectExplicitVideoGenerationCapabilities(provider);
    expect(provider.capabilities.generate?.supportsAudio).toBe(false);
    expect(provider.capabilities.imageToVideo?.supportsAudio).toBe(false);
    expect(provider.capabilities.videoToVideo?.supportsAudio).toBe(false);
  });

  it.each([
    "sdk-create",
    "sdk-poll",
    "sdk-operation",
    "rest-body",
    "rest-status",
    "rest-operation",
    "download-status",
  ] as const)("redacts the active credential from %s diagnostics", async (path) => {
    const credential = "opaque-video-key42";
    const diagnostic = `provider diagnostic ${credential}`;
    mockGoogleApiKeyAuth(path === "download-status" ? "google-key" : credential);
    if (path === "sdk-create") {
      generateVideosMock.mockRejectedValue(new ApiError({ status: 403, message: diagnostic }));
    } else if (path === "sdk-poll") {
      vi.useFakeTimers();
      generateVideosMock.mockResolvedValue({ done: false, name: "operations/pending" });
      getVideosOperationMock.mockRejectedValue(new ApiError({ status: 403, message: diagnostic }));
    } else if (path === "sdk-operation") {
      generateVideosMock.mockResolvedValue({ done: true, error: { message: diagnostic } });
    } else if (path === "download-status") {
      generateVideosMock.mockResolvedValue(
        completedVideo({
          uri: `https://generativelanguage.googleapis.com/v1beta/files/video:download?key=${credential}`,
          mimeType: "video/mp4",
        }),
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 403, statusText: diagnostic })),
      );
    } else {
      generateVideosMock.mockRejectedValue(new ApiError({ status: 404, message: "sdk 404" }));
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (path === "rest-body") {
            return Response.json({ error: { message: diagnostic } }, { status: 403 });
          }
          if (path === "rest-status") {
            return new Response(null, { status: 403, statusText: diagnostic });
          }
          return Response.json({ done: true, error: { message: diagnostic } });
        }),
      );
    }

    const result = generateVideo().catch((error: unknown) => error);
    if (path === "sdk-poll") {
      await vi.advanceTimersByTimeAsync(10_000);
    }
    const error = await result;
    assert(error instanceof Error);
    expect(formatErrorMessage(error)).not.toContain(credential);
    expect(error.message).toContain("provider diagnostic");
    if (path === "sdk-create" || path === "sdk-poll") {
      expect(error).toMatchObject({ name: "ApiError", status: 403 });
    } else if (path === "rest-body" || path === "rest-status") {
      expect(error).toMatchObject({ status: 403, statusCode: 403 });
    }
  });

  it("submits generation and returns inline video bytes", async () => {
    mockGoogleApiKeyAuth();
    const videoBytes = Buffer.from([0xfb, 0xff, 0x6d, 0x70, 0x34]);
    generateVideosMock.mockResolvedValue(
      completedVideo(
        {
          videoBytes: videoBytes.toString("base64url"),
          mimeType: "video/mp4",
        },
        { name: "operations/123" },
      ),
    );
    const result = await generateVideo({
      aspectRatio: "16:9",
      resolution: "720P",
      durationSeconds: 3,
      audio: true,
    });

    expect(generateVideosMock).toHaveBeenCalledTimes(1);
    const request = firstObjectArg(generateVideosMock);
    expect(request.model).toBe("veo-3.1-fast-generate-preview");
    expect(request.prompt).toBe("A tiny robot watering a windowsill garden");
    const config = recordField(request.config, "config");
    expect(config.durationSeconds).toBe(4);
    expect(config.aspectRatio).toBe("16:9");
    expect(config.resolution).toBe("720p");
    expect(config).not.toHaveProperty("generateAudio");
    expect(config).not.toHaveProperty("numberOfVideos");
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.buffer).toEqual(videoBytes);
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    const clientOptions = firstObjectArg(createGoogleGenAIMock);
    expect(clientOptions.apiKey).toBe("google-key");
    const httpOptions = recordField(clientOptions.httpOptions, "httpOptions");
    expect(httpOptions).not.toHaveProperty("baseUrl");
    expect(httpOptions).not.toHaveProperty("apiVersion");
  });

  it.each([
    {
      name: "image default MIME",
      input: { inputImages: [{ buffer: Buffer.from([0, 255, 128]) }] },
      image: { imageBytes: "AP+A", mimeType: "image/png" },
      video: undefined,
    },
    {
      name: "video default MIME",
      input: { inputVideos: [{ buffer: Buffer.from([0, 255, 128]), mimeType: " " }] },
      image: undefined,
      video: { videoBytes: "AP+A", mimeType: "video/mp4" },
    },
    {
      name: "image explicit MIME",
      input: { inputImages: [{ buffer: Buffer.from([0, 255, 128]), mimeType: " image/WebP " }] },
      image: { imageBytes: "AP+A", mimeType: "image/WebP" },
      video: undefined,
    },
    {
      name: "video empty buffer",
      input: { inputVideos: [{ buffer: Buffer.alloc(0), mimeType: " video/WebM " }] },
      image: undefined,
      video: { videoBytes: "", mimeType: "video/WebM" },
    },
    {
      name: "URL-only image",
      input: { inputImages: [{ url: "https://example.com/reference.png" }] },
      image: undefined,
      video: undefined,
    },
  ])("encodes $name at the SDK boundary", async ({ input, image, video }) => {
    mockGoogleApiKeyAuth();
    generateVideosMock.mockResolvedValue(completedVideo({ videoBytes: "b3V0" }));

    const result = await generateVideo(input);

    expect(generateVideosMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ image, video }),
    );
    expect(result.videos[0]?.buffer).toEqual(Buffer.from("out"));
  });

  it.each([
    ["non-canonical pad bits", "ZE=="],
    ["mixed alphabet", "aGVsbG8+_"],
  ])("rejects %s in inline video bytes", async (_scenario, videoBytes) => {
    mockGoogleApiKeyAuth();
    generateVideosMock.mockResolvedValue(completedVideo({ videoBytes, mimeType: "video/mp4" }));

    await expect(
      generateVideo({
        durationSeconds: 3,
      }),
    ).rejects.toThrow("Google video generation returned malformed base64 video data");
  });

  it("rejects oversized inline video before canonicalization or decoding", async () => {
    mockGoogleApiKeyAuth();
    const videoBytes = " -_9tcDQ\n";
    generateVideosMock.mockResolvedValue(
      completedVideo({
        videoBytes,
        mimeType: "video/mp4",
      }),
    );
    const canonicalize = vi.spyOn(googleBase64, "canonicalizeGoogleProviderBase64");
    const decode = vi.spyOn(Buffer, "from");
    await expect(
      generateVideo({
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
        durationSeconds: 3,
      }),
    ).rejects.toThrow("Google generated video download exceeds 1 bytes");
    expect(canonicalize).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalledWith(expect.any(String), "base64");
  });

  it.each([
    { videoBytes: "YQ==", expected: [0x61], maxBytes: 1 },
    { videoBytes: " -_8\n", expected: [0xfb, 0xff], maxBytes: 2 },
  ])("accepts inline video exactly at the $maxBytes-byte cap", async (fixture) => {
    mockGoogleApiKeyAuth();
    generateVideosMock.mockResolvedValue(completedVideo({ videoBytes: fixture.videoBytes }));

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
    generateVideosMock.mockResolvedValue(
      completedVideo({ videoBytes: Buffer.from("mp4").toString("base64"), mimeType: "video/mp4" }),
    );

    await generateVideo({
      prompt,
      cfg: { models: { providers: { google: { baseUrl, models: [] } } } },
      durationSeconds: 3,
    });

    expect(firstGoogleClientHttpOptions().baseUrl).toBe(expectedBaseUrl);
  });

  it("downloads MLDev direct video uri responses without routing through the Files API", async () => {
    mockGoogleApiKeyAuth();
    generateVideosMock.mockResolvedValue(
      completedVideo({
        uri: "https://generativelanguage.googleapis.com/v1beta/files/generated-video:download?alt=media",
        mimeType: "video/mp4",
      }),
    );
    const fetchMock = vi.fn(async () => {
      return new Response("direct-mp4", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "video/mp4" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateVideo({
      durationSeconds: 3,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [[downloadUrl]] = fetchMock.mock.calls as unknown as [[string, RequestInit?]];
    expect(downloadUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/files/generated-video:download?alt=media&key=google-key",
    );
    expect(downloadMock).not.toHaveBeenCalled();
    expect(result.videos[0]?.buffer).toEqual(Buffer.from("direct-mp4"));
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
  });

  it("rejects direct video uri downloads that exceed the configured media cap", async () => {
    mockGoogleApiKeyAuth();
    generateVideosMock.mockResolvedValue(
      completedVideo({
        uri: "https://generativelanguage.googleapis.com/v1beta/files/generated-video:download?alt=media",
        mimeType: "video/mp4",
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("too-large", {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "video/mp4" },
          }),
      ),
    );
    await expect(
      generateVideo({
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
        durationSeconds: 3,
      }),
    ).rejects.toThrow("Google generated video download exceeds 1 bytes");
  });

  it.each([
    { name: "JSON error", contentType: "application/json", body: '{"error":"denied"}' },
    { name: "problem JSON", contentType: "application/problem+json", body: '{"title":"denied"}' },
    { name: "HTML", contentType: "text/html; charset=utf-8", body: "<html>sign in</html>" },
    { name: "empty video", contentType: "video/mp4", body: "" },
  ])("rejects a successful $name direct video uri response", async ({ contentType, body }) => {
    mockGoogleApiKeyAuth();
    generateVideosMock.mockResolvedValue(
      completedVideo({
        uri: "https://generativelanguage.googleapis.com/v1beta/files/generated-video:download?alt=media",
        mimeType: "video/mp4",
      }),
    );
    const fetchMock = vi.fn(async () => {
      return new Response(body, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": contentType },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateVideo({
        durationSeconds: 3,
      }),
    ).rejects.toThrow("Google generated video download: malformed video response");
  });

  it("cancels each captured failed video download without waiting for its cloned stream", async () => {
    mockGoogleApiKeyAuth();
    generateVideosMock.mockResolvedValue(
      completedVideo({
        uri: "https://generativelanguage.googleapis.com/v1beta/files/generated-video:download?alt=media",
        mimeType: "video/mp4",
      }),
    );

    const capturedResponses: Response[] = [];
    const canceledBodies: ReadableStream<Uint8Array>[] = [];
    const fetchMock = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
      });
      const response = new Response(body, {
        status: 503,
        statusText: "Service Unavailable",
      });
      capturedResponses.push(response.clone());
      const responseBody = response.body;
      if (!responseBody) {
        throw new Error("expected a streaming video download response");
      }
      const cancel = responseBody.cancel.bind(responseBody);
      vi.spyOn(responseBody, "cancel").mockImplementation((reason) => {
        canceledBodies.push(responseBody);
        return cancel(reason);
      });
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(
        generateVideo({
          durationSeconds: 3,
        }),
      ).rejects.toThrow("Failed to download Google generated video: 503 Service Unavailable");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(canceledBodies).toHaveLength(2);
      expect(canceledBodies[0]).not.toBe(canceledBodies[1]);
    } finally {
      await Promise.all(
        capturedResponses.map(async (response) => {
          await response.body?.cancel();
        }),
      );
    }
  });

  it("preserves the video download error when a failed response has no body", async () => {
    mockGoogleApiKeyAuth();
    generateVideosMock.mockResolvedValue(
      completedVideo({
        uri: "https://generativelanguage.googleapis.com/v1beta/files/generated-video:download?alt=media",
        mimeType: "video/mp4",
      }),
    );
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 503, statusText: "Service Unavailable" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateVideo({
        durationSeconds: 3,
      }),
    ).rejects.toThrow("Failed to download Google generated video: 503 Service Unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("downloads SDK file handles through the bounded REST media endpoint", async () => {
    mockGoogleApiKeyAuth();
    generateVideosMock.mockResolvedValue(
      completedVideo({
        uri: "files/generated-video",
        mimeType: "video/mp4",
      }),
    );
    const fetchMock = vi.fn(async () => {
      return new Response("sdk-video", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "video/mp4" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateVideo({
      durationSeconds: 3,
    });

    expect(fetchInputUrl(fetchMock, 0)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/files/generated-video:download?alt=media&key=google-key",
    );
    expect(downloadMock).not.toHaveBeenCalled();
    expect(result.videos[0]?.buffer).toEqual(Buffer.from("sdk-video"));
    expect(result.videos[0]?.fileName).toBe("video-1.mp4");
  });

  it("rejects SDK file-handle downloads that exceed the configured media cap", async () => {
    mockGoogleApiKeyAuth();
    generateVideosMock.mockResolvedValue(
      completedVideo({
        uri: "files/generated-video",
        mimeType: "video/mp4",
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("too-large", {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "video/mp4" },
          }),
      ),
    );
    await expect(
      generateVideo({
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
        durationSeconds: 3,
      }),
    ).rejects.toThrow("Google generated video download exceeds 1 bytes");
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it.each(["google/veo-3.1-fast-generate-preview", "google/models/veo-3.1-fast-generate-preview"])(
    "normalizes %s for SDK submission while preserving the result model",
    async (model) => {
      mockGoogleApiKeyAuth();
      generateVideosMock.mockResolvedValue(
        completedVideo({
          videoBytes: Buffer.from("mp4").toString("base64"),
          mimeType: "video/mp4",
        }),
      );
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await generateVideo({ model });

      expect(generateVideosMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ model: model.slice("google/".length) }),
      );
      expect(result.model).toBe(model);
      expect(result.videos[0]?.buffer).toEqual(Buffer.from("mp4"));
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "empty", response: { generatedVideos: [] } },
    {
      name: "filtered",
      response: {
        generatedVideos: [],
        raiMediaFilteredCount: 1,
        raiMediaFilteredReasons: ["Synthetic content filter"],
      },
    },
  ])(
    "reports a completed $name result without submitting another generation",
    async ({ response }) => {
      mockGoogleApiKeyAuth();
      generateVideosMock.mockResolvedValue({ done: true, name: "operations/empty", response });
      const fetchMock = vi.fn(() => {
        throw new Error("Unexpected second generation request");
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(generateVideo()).rejects.toThrow(
        "Google video generation response missing generated videos",
      );

      expect(generateVideosMock).toHaveBeenCalledOnce();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("falls back to REST predictLongRunning when text-only SDK video generation returns 404", async () => {
    mockGoogleApiKeyAuth();
    generateVideosMock.mockRejectedValue(Object.assign(new Error("sdk 404"), { status: 404 }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            done: true,
            name: "operations/rest-123",
            response: {
              generateVideoResponse: {
                generatedSamples: [
                  {
                    video: {
                      uri: "https://generativelanguage.googleapis.com/v1beta/files/rest-video:download?alt=media",
                      mimeType: "video/mp4",
                    },
                  },
                ],
              },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response("rest-video", {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "video/mp4" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateVideo({
      model: "google/models/veo-3.1-fast-generate-preview",
      durationSeconds: 3,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchInputUrl(fetchMock, 0)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-fast-generate-preview:predictLongRunning",
    );
    expect(parseFetchJsonBody(fetchMock, 0)).toEqual({
      instances: [{ prompt: "A tiny robot watering a windowsill garden" }],
      parameters: { durationSeconds: 4 },
    });
    expect(fetchInputUrl(fetchMock, 1)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/files/rest-video:download?alt=media&key=google-key",
    );
    expect(downloadMock).not.toHaveBeenCalled();
    expect(result.videos[0]?.buffer).toEqual(Buffer.from("rest-video"));
  });

  it.each(["headers", "body"] as const)(
    "bounds REST %s waits by the operation deadline",
    async (phase) => {
      vi.useFakeTimers();
      mockGoogleApiKeyAuth();
      generateVideosMock.mockRejectedValue(Object.assign(new Error("sdk 404"), { status: 404 }));
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
      const rejection = expect(generateVideo({ timeoutMs: 1_000 })).rejects.toMatchObject({
        name: "TimeoutError",
        message: "request timed out",
      });
      await started.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("bounds successful Google REST operation JSON bodies instead of buffering the whole response", async () => {
    mockGoogleApiKeyAuth();
    generateVideosMock.mockRejectedValue(Object.assign(new Error("sdk 404"), { status: 404 }));
    const streamed = oversizedJsonResponse({ chunkCount: 64, chunkSize: 1024 * 1024 });
    const fetchMock = vi.fn(async () => streamed.response);
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      generateVideo({
        durationSeconds: 3,
      }),
    ).rejects.toThrow("Google video operation response: JSON response exceeds 16777216 bytes");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(streamed.getReadCount()).toBeLessThan(64);
    expect(streamed.wasCanceled()).toBe(true);
  });

  it("reports malformed Google REST operation JSON with a stable provider error", async () => {
    const credential = "opaque-video-key42";
    mockGoogleApiKeyAuth(credential);
    generateVideosMock.mockRejectedValue(Object.assign(new Error("sdk 404"), { status: 404 }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(credential, { status: 200 })));

    const error: unknown = await generateVideo({ durationSeconds: 3 }).catch(
      (cause: unknown) => cause,
    );
    assert(error instanceof Error);
    expect(error.message).toBe("Google video operation response: malformed JSON response");
    expect(formatErrorMessage(error)).not.toContain(credential);
    expect(error.cause).toBeUndefined();
  });

  it("rejects invalid UTF-8 in Google REST operation JSON before parsing", async () => {
    mockGoogleApiKeyAuth();
    generateVideosMock.mockRejectedValue(Object.assign(new Error("sdk 404"), { status: 404 }));
    const invalidUtf8Json = new Uint8Array([
      ...Buffer.from('{"done":true,"name":"operations/'),
      0xff,
      ...Buffer.from('"}'),
    ]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(invalidUtf8Json)));

    await expect(
      generateVideo({
        durationSeconds: 3,
      }),
    ).rejects.toThrow("Google video operation response: malformed JSON response");
  });

  it("retries transient Google REST poll failures with empty bodies", async () => {
    vi.useFakeTimers();
    mockGoogleApiKeyAuth();
    generateVideosMock.mockRejectedValue(Object.assign(new Error("sdk 404"), { status: 404 }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            done: false,
            name: "operations/rest-123",
          }),
        ),
      )
      .mockResolvedValueOnce(new Response("", { status: 503, statusText: "Service Unavailable" }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            done: true,
            name: "operations/rest-123",
            response: {
              generateVideoResponse: {
                generatedSamples: [
                  {
                    video: {
                      uri: "https://generativelanguage.googleapis.com/v1beta/files/rest-video:download?alt=media",
                      mimeType: "video/mp4",
                    },
                  },
                ],
              },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response("rest-video", {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "video/mp4" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const resultPromise = generateVideo({
      durationSeconds: 3,
    });
    await vi.advanceTimersByTimeAsync(10_250);
    const result = await resultPromise;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchInputUrl(fetchMock, 1)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/operations/rest-123",
    );
    expect(fetchInputUrl(fetchMock, 2)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/operations/rest-123",
    );
    expect(result.videos[0]?.buffer).toEqual(Buffer.from("rest-video"));
  });

  it("does not fall back to REST when SDK video generation with reference inputs returns 404", async () => {
    mockGoogleApiKeyAuth();
    generateVideosMock.mockRejectedValue(Object.assign(new Error("sdk 404"), { status: 404 }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      generateVideo({
        prompt: "Animate this sketch",
        inputImages: [{ buffer: Buffer.from("img"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow("sdk 404");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects mixed image and video inputs", async () => {
    mockGoogleApiKeyAuth();

    await expect(
      generateVideo({
        prompt: "Animate",
        inputImages: [{ buffer: Buffer.from("img"), mimeType: "image/png" }],
        inputVideos: [{ buffer: Buffer.from("vid"), mimeType: "video/mp4" }],
      }),
    ).rejects.toThrow("Google video generation does not support image and video inputs together.");
  });

  it("rounds unsupported durations to the nearest Veo value", async () => {
    mockGoogleApiKeyAuth();
    generateVideosMock.mockResolvedValue(
      completedVideo({
        videoBytes: Buffer.from("mp4-bytes").toString("base64"),
        mimeType: "video/mp4",
      }),
    );
    await generateVideo({
      durationSeconds: 5,
    });

    const request = firstObjectArg(generateVideosMock);
    const config = recordField(request.config, "config");
    expect(config.durationSeconds).toBe(6);
  });
});

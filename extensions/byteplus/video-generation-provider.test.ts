// Byteplus tests cover video generation provider plugin behavior.
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Submit/poll transport is mocked locally so each test can inject the BytePlus task JSON
// bodies, while readProviderJsonResponse is kept REAL (via importActual) so the byte-bounded
// reader actually streams and cancels oversized bodies under test instead of a stub.
const {
  postJsonRequestMock,
  fetchWithTimeoutMock,
  fetchWithTimeoutGuardedMock,
  resolveApiKeyForProviderMock,
} = vi.hoisted(() => ({
  postJsonRequestMock: vi.fn(),
  fetchWithTimeoutMock: vi.fn(),
  fetchWithTimeoutGuardedMock: vi.fn(),
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "provider-key" })),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", async (importActual) => {
  const actual = await importActual<typeof import("openclaw/plugin-sdk/provider-http")>();
  const resolveTimeoutMs = (timeoutMs: unknown): number =>
    typeof timeoutMs === "function" ? (timeoutMs() as number) : ((timeoutMs as number) ?? 60_000);
  return {
    // REAL byte-bounded JSON reader under test — not stubbed.
    readProviderJsonResponse: actual.readProviderJsonResponse,
    sanitizeConfiguredModelProviderRequest: actual.sanitizeConfiguredModelProviderRequest,
    postJsonRequest: postJsonRequestMock,
    fetchProviderOperationResponse: async (params: {
      url: string;
      init?: RequestInit;
      timeoutMs?: unknown;
      fetchFn: typeof fetch;
    }) => fetchWithTimeoutMock(params.url, params.init ?? {}, resolveTimeoutMs(params.timeoutMs)),
    fetchProviderDownloadResponse: async (params: {
      url: string;
      init?: RequestInit;
      timeoutMs?: unknown;
      fetchFn: typeof fetch;
    }) => fetchWithTimeoutMock(params.url, params.init ?? {}, resolveTimeoutMs(params.timeoutMs)),
    fetchWithTimeoutGuarded: fetchWithTimeoutGuardedMock.mockImplementation(
      async (url: string, init: RequestInit, timeoutMs: number) => ({
        response: await fetchWithTimeoutMock(url, init, timeoutMs),
        release: vi.fn(async () => {}),
      }),
    ),
    assertOkOrThrowHttpError: actual.assertOkOrThrowHttpError,
    createProviderOperationDeadline: ({
      label,
      timeoutMs,
    }: {
      label: string;
      timeoutMs?: number;
    }) => ({ label, timeoutMs }),
    createProviderOperationTimeoutResolver:
      ({ defaultTimeoutMs }: { defaultTimeoutMs: number }) =>
      () =>
        defaultTimeoutMs,
    resolveProviderOperationTimeoutMs: ({ defaultTimeoutMs }: { defaultTimeoutMs: number }) =>
      defaultTimeoutMs,
    resolveProviderHttpRequestConfig: (params: {
      baseUrl?: string;
      defaultBaseUrl: string;
      allowPrivateNetwork?: boolean;
      defaultHeaders?: Record<string, string>;
      request?: {
        allowPrivateNetwork?: boolean;
        headers?: Record<string, string>;
      };
    }) => {
      const mergedHeaders = new Headers(params.defaultHeaders);
      if (params.request?.headers) {
        for (const [key, value] of Object.entries(params.request.headers)) {
          mergedHeaders.set(key, value);
        }
      }
      const allowPrivateNetwork =
        params.allowPrivateNetwork ?? params.request?.allowPrivateNetwork ?? false;
      return {
        baseUrl: params.baseUrl ?? params.defaultBaseUrl,
        allowPrivateNetwork,
        headers: mergedHeaders,
        dispatcherPolicy: undefined,
      };
    },
    waitProviderOperationPollInterval: async () => {},
  };
});

let buildBytePlusVideoGenerationProvider: typeof import("./video-generation-provider.js").buildBytePlusVideoGenerationProvider;

beforeAll(async () => {
  ({ buildBytePlusVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

afterEach(() => {
  postJsonRequestMock.mockReset();
  fetchWithTimeoutMock.mockReset();
  fetchWithTimeoutGuardedMock.mockClear();
  resolveApiKeyForProviderMock.mockClear();
});

function mockSuccessfulBytePlusTask(params?: { model?: string }) {
  postJsonRequestMock.mockResolvedValue({
    response: streamedJsonResponse({
      id: "task_123",
    }),
    release: vi.fn(async () => {}),
  });
  fetchWithTimeoutMock
    .mockResolvedValueOnce(
      streamedJsonResponse({
        id: "task_123",
        status: "succeeded",
        content: {
          video_url: "https://example.com/byteplus.mp4",
        },
        model: params?.model ?? "seedance-1-0-lite-t2v-250428",
      }),
    )
    .mockResolvedValueOnce(
      new Response(Buffer.from("webm-bytes"), {
        headers: new Headers({ "content-type": "video/webm" }),
      }),
    );
}

function requireBytePlusPostRequest(): { body?: Record<string, unknown>; url?: string } {
  const [call] = postJsonRequestMock.mock.calls;
  if (!call) {
    throw new Error("expected BytePlus video request");
  }
  const [request] = call;
  if (!request) {
    throw new Error("expected BytePlus video request");
  }
  if (typeof request !== "object" || Array.isArray(request)) {
    throw new Error("expected BytePlus video request options");
  }
  return request as { body?: Record<string, unknown>; url?: string };
}

function requireBytePlusPostBody(): Record<string, unknown> {
  const request = requireBytePlusPostRequest();
  if (!request.body) {
    throw new Error("expected BytePlus video request body");
  }
  return request.body;
}

function streamedVideoResponse(bytes: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(bytes));
        controller.close();
      },
    }),
    { headers: { "content-type": "video/mp4" } },
  );
}

// BytePlus submit/poll task JSON is now read through the byte-bounded reader, so the
// mocked responses must expose a real readable body (not just a json() shortcut).
function streamedJsonResponse(payload: unknown): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// Builds a JSON body larger than the shared 16 MiB readProviderJsonResponse cap so the
// bounded reader cancels the stream mid-flight; if the cap were removed the reader would
// buffer the whole advertised payload before parsing. Tracks how many bytes were pulled
// and whether the stream was canceled so callers can assert the body was not fully read.
function makeOversizedJsonStream(): {
  body: ReadableStream<Uint8Array>;
  maxBytes: number;
  totalBytes: number;
  state: { bytesPulled: number; canceled: boolean };
} {
  const maxBytes = 16 * 1024 * 1024; // matches PROVIDER_JSON_RESPONSE_MAX_BYTES.
  const ONE_MIB = 1024 * 1024;
  const TOTAL_CHUNKS = 32; // 32 MiB advertised body, double the cap.
  const chunk = new Uint8Array(ONE_MIB);
  const state = { bytesPulled: 0, canceled: false };
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= TOTAL_CHUNKS) {
        controller.close();
        return;
      }
      pulled += 1;
      state.bytesPulled += chunk.length;
      controller.enqueue(chunk);
    },
    cancel() {
      state.canceled = true;
    },
  });
  return { body, maxBytes, totalBytes: TOTAL_CHUNKS * ONE_MIB, state };
}

describe("byteplus video generation provider", () => {
  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildBytePlusVideoGenerationProvider());
  });

  it("creates a content-generation task, polls, and downloads the video", async () => {
    mockSuccessfulBytePlusTask();

    const provider = buildBytePlusVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "byteplus",
      model: "seedance-1-0-lite-t2v-250428",
      prompt: "A lantern floats upward into the night sky",
      cfg: {},
    });

    expect(postJsonRequestMock).toHaveBeenCalledTimes(1);
    const request = requireBytePlusPostRequest();
    expect(request.url).toBe(
      "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks",
    );
    expect(result.videos).toHaveLength(1);
    const [video] = result.videos;
    if (!video) {
      throw new Error("Expected generated BytePlus video");
    }
    expect(video.fileName).toBe("video-1.webm");
    const metadata = result.metadata as Record<string, unknown>;
    expect(metadata.taskId).toBe("task_123");
  });

  it("applies configured provider request overrides to transport", async () => {
    mockSuccessfulBytePlusTask();

    const provider = buildBytePlusVideoGenerationProvider();
    await provider.generateVideo({
      provider: "byteplus",
      model: "seedance-1-0-lite-t2v-250428",
      prompt: "A lantern floats upward into the night sky",
      cfg: {
        models: {
          providers: {
            byteplus: {
              baseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3",
              models: [],
              request: {
                allowPrivateNetwork: true,
                headers: {
                  "X-Custom-Header": "custom-value",
                },
              },
            },
          },
        },
      },
    });

    expect(postJsonRequestMock).toHaveBeenCalledTimes(1);
    const [postCall] = postJsonRequestMock.mock.calls;
    if (!postCall) {
      throw new Error("expected BytePlus video request");
    }
    const [postRequest] = postCall as [Record<string, unknown>];
    expect(postRequest.allowPrivateNetwork).toBe(true);
    const postHeaders = postRequest.headers as Headers;
    expect(postHeaders.get("X-Custom-Header")).toBe("custom-value");
    expect(postHeaders.get("Authorization")).toBe("Bearer provider-key");

    // Status poll and video download must also use the configured private-network policy.
    expect(fetchWithTimeoutGuardedMock).toHaveBeenCalledTimes(2);
    const [pollCall, downloadCall] = fetchWithTimeoutGuardedMock.mock.calls;
    if (!pollCall || !downloadCall) {
      throw new Error("expected BytePlus guarded poll and download requests");
    }
    const pollOptions = pollCall[4] as {
      ssrfPolicy?: { allowPrivateNetwork?: boolean };
      auditContext?: string;
    };
    expect(pollOptions.ssrfPolicy?.allowPrivateNetwork).toBe(true);
    expect(pollOptions.auditContext).toBe("byteplus-video-poll");
    const downloadUrl = downloadCall[0] as string;
    const downloadOptions = downloadCall[4] as {
      ssrfPolicy?: { allowPrivateNetwork?: boolean };
      auditContext?: string;
    };
    expect(downloadUrl).toBe("https://example.com/byteplus.mp4");
    expect(downloadOptions.ssrfPolicy?.allowPrivateNetwork).toBe(true);
    expect(downloadOptions.auditContext).toBe("byteplus-video-download");

    // Guarded poll/download results must be released to avoid leaking dispatcher connections.
    const [pollResult, downloadResult] = fetchWithTimeoutGuardedMock.mock.results;
    if (pollResult?.type === "return") {
      const { release } = (await pollResult.value) as { release: ReturnType<typeof vi.fn> };
      expect(release).toHaveBeenCalledTimes(1);
    }
    if (downloadResult?.type === "return") {
      const { release } = (await downloadResult.value) as { release: ReturnType<typeof vi.fn> };
      expect(release).toHaveBeenCalledTimes(1);
    }
  });

  it("releases guarded results when a non-2xx poll/download response is returned", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({ id: "task_500" }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock.mockResolvedValueOnce(new Response("BytePlus error", { status: 500 }));

    const provider = buildBytePlusVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "byteplus",
        model: "seedance-1-0-lite-t2v-250428",
        prompt: "guarded error path",
        cfg: {
          models: {
            providers: {
              byteplus: {
                baseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3",
                models: [],
                request: { allowPrivateNetwork: true },
              },
            },
          },
        },
      }),
    ).rejects.toThrow();

    expect(fetchWithTimeoutGuardedMock).toHaveBeenCalledTimes(1);
    const [pollResult] = fetchWithTimeoutGuardedMock.mock.results;
    if (pollResult?.type === "return") {
      const { release } = (await pollResult.value) as { release: ReturnType<typeof vi.fn> };
      expect(release).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects generated video downloads that exceed the configured media cap", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({ id: "task_too_large" }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        streamedJsonResponse({
          id: "task_too_large",
          status: "succeeded",
          content: {
            video_url: "https://example.com/too-large.mp4",
          },
        }),
      )
      .mockResolvedValueOnce(streamedVideoResponse("too-large"));

    const provider = buildBytePlusVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "byteplus",
        model: "seedance-1-0-lite-t2v-250428",
        prompt: "short video",
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
      }),
    ).rejects.toThrow("BytePlus generated video download exceeds 1 bytes");
  });

  it("switches t2v image requests to i2v models and lowercases resolution", async () => {
    mockSuccessfulBytePlusTask({ model: "seedance-1-0-lite-i2v-250428" });

    const provider = buildBytePlusVideoGenerationProvider();
    await provider.generateVideo({
      provider: "byteplus",
      model: "seedance-1-0-lite-t2v-250428",
      prompt: "Animate this still image",
      resolution: "720P",
      inputImages: [{ url: "https://example.com/first-frame.png" }],
      cfg: {},
    });

    expect(requireBytePlusPostBody()).toEqual({
      model: "seedance-1-0-lite-i2v-250428",
      resolution: "720p",
      content: [
        { type: "text", text: "Animate this still image" },
        {
          type: "image_url",
          image_url: { url: "https://example.com/first-frame.png" },
          role: "first_frame",
        },
      ],
    });
  });

  it("maps declared providerOptions into the request body", async () => {
    mockSuccessfulBytePlusTask({ model: "seedance-1-0-pro-250528" });

    const provider = buildBytePlusVideoGenerationProvider();
    await provider.generateVideo({
      provider: "byteplus",
      model: "seedance-1-0-pro-250528",
      prompt: "A cinematic lobster montage",
      providerOptions: {
        seed: 42,
        draft: true,
        camera_fixed: false,
      },
      cfg: {},
    });

    const body = requireBytePlusPostBody();
    expect(body.model).toBe("seedance-1-0-pro-250528");
    expect(body.seed).toBe(42);
    expect(body.resolution).toBe("480p");
    expect(body.camera_fixed).toBe(false);
  });

  it("drops malformed seed values before creating videos", async () => {
    mockSuccessfulBytePlusTask({ model: "seedance-1-0-pro-250528" });

    const provider = buildBytePlusVideoGenerationProvider();
    await provider.generateVideo({
      provider: "byteplus",
      model: "seedance-1-0-pro-250528",
      prompt: "A cinematic lobster montage",
      providerOptions: {
        seed: 1.5,
      },
      cfg: {},
    });

    expect(requireBytePlusPostBody()).not.toHaveProperty("seed");
  });

  it("drops out-of-range duration values before creating videos", async () => {
    mockSuccessfulBytePlusTask({ model: "seedance-1-0-pro-250528" });

    const provider = buildBytePlusVideoGenerationProvider();
    await provider.generateVideo({
      provider: "byteplus",
      model: "seedance-1-0-pro-250528",
      prompt: "A cinematic lobster montage",
      durationSeconds: 99,
      cfg: {},
    });

    expect(requireBytePlusPostBody()).not.toHaveProperty("duration");
  });

  it("drops malformed response duration metadata", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({
        id: "task_123",
      }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        streamedJsonResponse({
          id: "task_123",
          status: "succeeded",
          content: {
            video_url: "https://example.com/byteplus.mp4",
          },
          duration: 1.5,
        }),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from("mp4-bytes"), {
          headers: new Headers({ "content-type": "video/mp4" }),
        }),
      );

    const provider = buildBytePlusVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "byteplus",
      model: "seedance-1-0-lite-t2v-250428",
      prompt: "A lantern floats upward into the night sky",
      cfg: {},
    });

    expect(result.metadata).toMatchObject({ duration: undefined });
  });

  it("reports malformed create JSON with a provider-owned error", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{ not valid json"));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      release,
    });

    const provider = buildBytePlusVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "byteplus",
        model: "seedance-1-0-lite-t2v-250428",
        prompt: "bad create response",
        cfg: {},
      }),
    ).rejects.toThrow("BytePlus video generation failed: malformed JSON response");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects status responses missing a task status", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({ id: "task_missing_status" }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock.mockResolvedValueOnce(
      streamedJsonResponse({
        id: "task_missing_status",
        content: {
          video_url: "https://example.com/byteplus.mp4",
        },
      }),
    );

    const provider = buildBytePlusVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "byteplus",
        model: "seedance-1-0-lite-t2v-250428",
        prompt: "missing status",
        cfg: {},
      }),
    ).rejects.toThrow("BytePlus video status response missing task status");
  });

  it("rejects malformed completed content", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({ id: "task_malformed_content" }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock.mockResolvedValueOnce(
      streamedJsonResponse({
        id: "task_malformed_content",
        status: "succeeded",
        content: ["https://example.com/byteplus.mp4"],
      }),
    );

    const provider = buildBytePlusVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "byteplus",
        model: "seedance-1-0-lite-t2v-250428",
        prompt: "malformed content",
        cfg: {},
      }),
    ).rejects.toThrow("BytePlus video generation completed with malformed content");
  });

  it("bounds the submit task JSON body and cancels an oversized stream", async () => {
    const stream = makeOversizedJsonStream();
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: new Response(stream.body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release,
    });

    const provider = buildBytePlusVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "byteplus",
        model: "seedance-1-0-lite-t2v-250428",
        prompt: "oversized submit response",
        cfg: {},
      }),
    ).rejects.toThrow(
      `BytePlus video generation failed: JSON response exceeds ${stream.maxBytes} bytes`,
    );
    expect(stream.state.canceled).toBe(true);
    // Only the bounded prefix is pulled, never the full advertised stream.
    expect(stream.state.bytesPulled).toBeLessThan(stream.totalBytes);
    // The submit request must still be released even though the body overflowed.
    expect(release).toHaveBeenCalledOnce();
  });

  it("bounds the poll status JSON body and cancels an oversized stream", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({ id: "task_oversized_poll" }),
      release: vi.fn(async () => {}),
    });
    const stream = makeOversizedJsonStream();
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(stream.body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const provider = buildBytePlusVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "byteplus",
        model: "seedance-1-0-lite-t2v-250428",
        prompt: "oversized poll response",
        cfg: {},
      }),
    ).rejects.toThrow(
      `BytePlus video status request failed: JSON response exceeds ${stream.maxBytes} bytes`,
    );
    expect(stream.state.canceled).toBe(true);
    expect(stream.state.bytesPulled).toBeLessThan(stream.totalBytes);
  });
});

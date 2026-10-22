import type { MusicGenerationRequest } from "openclaw/plugin-sdk/music-generation";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  expectAllowPrivateNetworkPolicy,
  expectMinimaxGuardedFetchCall,
  getMinimaxProviderHttpMocks,
  installMinimaxProviderHttpMockCleanup,
  loadMinimaxMusicGenerationProviderModule,
  mockCallArg,
} from "./provider-http.test-helpers.js";

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  executeProviderOperationWithRetryMock,
  fetchWithTimeoutMock,
  fetchWithTimeoutGuardedMock,
} = getMinimaxProviderHttpMocks();

let buildMinimaxMusicGenerationProvider: Awaited<
  ReturnType<typeof loadMinimaxMusicGenerationProviderModule>
>["buildMinimaxMusicGenerationProvider"];
beforeAll(async () => {
  ({ buildMinimaxMusicGenerationProvider } = await loadMinimaxMusicGenerationProviderModule());
});

installMinimaxProviderHttpMockCleanup();

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

function musicConfig(
  provider: string,
  baseUrl: string,
  request?: { allowPrivateNetwork: boolean; headers: Record<string, string> },
) {
  return { models: { providers: { [provider]: { baseUrl, models: [], request } } } };
}

function mockResponse(body: BodyInit, contentType = "text/event-stream"): void {
  postJsonRequestMock.mockResolvedValue({
    response: new Response(body, { headers: { "content-type": contentType } }),
    release: vi.fn(async () => {}),
  });
}

function mockMusicResponse(json: Record<string, unknown>): void {
  mockResponse(JSON.stringify({ base_resp: { status_code: 0 }, ...json }), "application/json");
}

function streamFrame(data: Record<string, unknown>, status_code = 0, status_msg?: string) {
  return `data: ${JSON.stringify({ data, base_resp: { status_code, status_msg } })}\n\n`;
}

function mockMusicDownload(): void {
  fetchWithTimeoutMock.mockResolvedValueOnce({
    headers: new Headers({ "content-type": "audio/mpeg" }),
    arrayBuffer: async () => Buffer.from("mp3-bytes"),
  });
}

function expectDownloadFetchTimeout(url: string, totalTimeoutMs: number): void {
  const call = fetchWithTimeoutMock.mock.calls[0];
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
  it.each(["minimax", "minimax-portal"])(
    "rejects an invalid %s media origin before resolving credentials or submitting music",
    async (providerId) => {
      await expect(
        generateMusic({ provider: providerId, cfg: musicConfig(providerId, "https://[") }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(resolveApiKeyForProviderMock).not.toHaveBeenCalled();
      expect(postJsonRequestMock).not.toHaveBeenCalled();
      expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    },
  );

  it("streams generated music chunks from MiniMax", async () => {
    using clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(1_700_000_000_000);
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
      cfg: musicConfig("minimax", "   "),
    });
    const request = mockCallArg(postJsonRequestMock);
    expect(request.url).toBe("https://api.minimax.io/v1/music_generation");
    expect(request.body).toEqual({
      model: "music-2.6",
      prompt: "upbeat dance-pop with female vocals",
      lyrics: "our city wakes",
      stream: true,
      output_format: "hex",
      audio_setting: { sample_rate: 44100, bitrate: 256000, format: "mp3" },
    });
    expect(request.timeoutMs).toBe(300000);
    expect(request?.headers).toBeInstanceOf(Headers);
    expect((request.headers as Headers).get("content-type")).toBe("application/json");
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]?.buffer).toEqual(Buffer.concat([chunkA, chunkB]));
    expect(result.tracks[0]?.mimeType).toBe("audio/mpeg");
    expect(result.metadata?.requestedLyrics).toBe(true);
    expect(result.metadata).not.toHaveProperty("requestedDurationSeconds");
  });

  it("cancels invalid music responses before releasing their guarded dispatcher", async () => {
    const cleanupOrder: string[] = [];
    mockMusicResponse({
      data: { audio_url: "https://example.com/invalid-open.mp3" },
    });
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce({
      response: new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"error":"still streaming"}'));
          },
          cancel() {
            cleanupOrder.push("body canceled");
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
      finalUrl: "https://example.com/invalid-open.mp3",
      release: vi.fn(async () => {
        cleanupOrder.push("dispatcher released");
      }),
    });

    await expect(generateMusic({ prompt: "invalid download" })).rejects.toThrow(
      "MiniMax generated music download: malformed audio response",
    );
    expect(cleanupOrder).toEqual(["body canceled", "dispatcher released"]);
  });

  it("rejects streamed audio outside MiniMax's documented hex format", async () => {
    mockResponse(streamFrame({ status: 1, audio: "ZE==" }));
    await expect(generateMusic({ model: "", prompt: "short track" })).rejects.toThrow(
      "MiniMax music generation returned malformed hex audio",
    );
  });

  it("reports streaming music task failures", async () => {
    mockResponse(streamFrame({}) + streamFrame({}, 2013, "render rejected"));
    await expect(generateMusic()).rejects.toThrow(
      "MiniMax music generation failed (2013): render rejected",
    );
  });

  it("rejects inline generated music that exceeds the configured media cap before decoding", async () => {
    mockMusicResponse({
      data: { audio: Buffer.from("too-large").toString("hex") },
    });
    await expect(
      generateMusic({
        prompt: "short track",
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
      }),
    ).rejects.toThrow("MiniMax generated music download exceeds 1 bytes");
  });

  it("downloads tracks when url output is returned in data.audio", async () => {
    mockMusicResponse({
      task_id: " task-url ",
      lyrics: "our city wakes",
      data: { audio: " https://example.com/url-audio.mp3 " },
    });
    mockMusicDownload();
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
    const requestOverrides = {
      allowPrivateNetwork: true,
      headers: { "X-MiniMax-Music-Policy": "enabled" },
    };
    mockMusicResponse({
      task_id: "task-retry",
      audio_url: "https://example.com/retry.mp3",
    });
    fetchWithTimeoutMock.mockRejectedValueOnce(new Error("request timeout"));
    mockMusicDownload();
    const result = await generateMusic({
      provider: "minimax-portal",
      prompt: "upbeat dance-pop",
      cfg: musicConfig("minimax-portal", "https://api.minimaxi.com", requestOverrides),
    });

    for (const attempt of [0, 1]) {
      expectAllowPrivateNetworkPolicy(
        expectMinimaxGuardedFetchCall(attempt, "https://example.com/retry.mp3").options,
      );
    }
    expect(result.tracks).toHaveLength(1);
    expect(
      executeProviderOperationWithRetryMock.mock.calls.map(
        ([params]) => (params as { stage: string }).stage,
      ),
    ).toContain("download");
  });
});

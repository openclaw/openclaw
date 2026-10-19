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

function musicRequest(overrides: Partial<MusicGenerationRequest> = {}): MusicGenerationRequest {
  return {
    provider: "minimax",
    model: "music-2.6",
    prompt: "upbeat dance-pop with female vocals",
    cfg: {},
    ...overrides,
  };
}

function mockMusicResponse(json: Record<string, unknown>): void {
  const response = new Response(JSON.stringify(json), {
    headers: { "content-type": "application/json" },
  });
  postJsonRequestMock.mockResolvedValue({
    response,
    release: vi.fn(async () => {}),
  });
}

function mockMusicGenerationResponse(json: Record<string, unknown>): void {
  mockMusicResponse(json);
  fetchWithTimeoutMock.mockResolvedValue({
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
        buildMinimaxMusicGenerationProvider(providerId).generateMusic(
          musicRequest({
            provider: providerId,
            cfg: {
              models: {
                providers: { [providerId]: { baseUrl: "https://[", models: [] } },
              },
            },
          }),
        ),
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
    postJsonRequestMock.mockResolvedValue({
      response: new Response(
        [
          `data: ${JSON.stringify({ data: { status: 1, audio: chunkA.toString("hex") }, base_resp: { status_code: 0 } })}`,
          `data: ${JSON.stringify({ data: { status: 1, audio: chunkB.toString("hex") }, base_resp: { status_code: 0 } })}`,
          `data: ${JSON.stringify({ data: { status: 2, audio: Buffer.concat([chunkA, chunkB]).toString("hex") }, base_resp: { status_code: 0 } })}`,
          "",
        ].join("\n\n"),
        {
          headers: { "content-type": "text/event-stream" },
        },
      ),
      release: vi.fn(async () => {}),
    });

    const provider = buildMinimaxMusicGenerationProvider();
    const result = await provider.generateMusic(
      musicRequest({
        model: "",
        lyrics: "our city wakes",
        durationSeconds: 45,
        cfg: { models: { providers: { minimax: { baseUrl: "   ", models: [] } } } },
      }),
    );

    const request = mockCallArg(postJsonRequestMock);
    expect(request.url).toBe("https://api.minimax.io/v1/music_generation");
    const body = request.body as Record<string, unknown>;
    expect(body.model).toBe("music-2.6");
    expect(body.prompt).toBe("upbeat dance-pop with female vocals");
    expect(body.prompt).not.toContain("Target duration");
    expect(body).not.toHaveProperty("duration");
    expect(body.lyrics).toBe("our city wakes");
    expect(body.stream).toBe(true);
    expect(body.output_format).toBe("hex");
    expect(body.audio_setting).toEqual({
      sample_rate: 44100,
      bitrate: 256000,
      format: "mp3",
    });
    expect(request.timeoutMs).toBe(300000);
    expect(request?.headers).toBeInstanceOf(Headers);
    const headers = request?.headers as Headers | undefined;
    expect(headers?.get("content-type")).toBe("application/json");
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
      base_resp: { status_code: 0 },
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

    await expect(
      buildMinimaxMusicGenerationProvider().generateMusic(
        musicRequest({ prompt: "invalid download" }),
      ),
    ).rejects.toThrow("MiniMax generated music download: malformed audio response");
    expect(cleanupOrder).toEqual(["body canceled", "dispatcher released"]);
  });

  it.each([
    {
      name: "streamed",
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify({ data: { status: 1, audio: "ZE==" }, base_resp: { status_code: 0 } })}\n\n`,
    },
  ])("rejects $name audio outside MiniMax's documented hex format", async (fixture) => {
    postJsonRequestMock.mockResolvedValue({
      response: new Response(fixture.body, {
        headers: { "content-type": fixture.contentType },
      }),
      release: vi.fn(async () => {}),
    });

    await expect(
      buildMinimaxMusicGenerationProvider().generateMusic(
        musicRequest({ model: "", prompt: "short track" }),
      ),
    ).rejects.toThrow("MiniMax music generation returned malformed hex audio");
  });

  it("reports streaming music task failures", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: new Response(
        `data: ${JSON.stringify({
          base_resp: { status_code: 0 },
        })}\n\ndata: ${JSON.stringify({
          base_resp: { status_code: 2013, status_msg: "render rejected" },
        })}`,
        {
          headers: { "content-type": "text/event-stream" },
        },
      ),
      release: vi.fn(async () => {}),
    });

    const provider = buildMinimaxMusicGenerationProvider();

    await expect(provider.generateMusic(musicRequest())).rejects.toThrow(
      "MiniMax music generation failed (2013): render rejected",
    );
  });

  it("rejects inline generated music that exceeds the configured media cap before decoding", async () => {
    mockMusicResponse({
      data: {
        audio: Buffer.from("too-large").toString("hex"),
      },
      base_resp: { status_code: 0 },
    });

    const provider = buildMinimaxMusicGenerationProvider();
    await expect(
      provider.generateMusic(
        musicRequest({
          prompt: "short track",
          cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
        }),
      ),
    ).rejects.toThrow("MiniMax generated music download exceeds 1 bytes");
  });

  it("downloads tracks when url output is returned in data.audio", async () => {
    mockMusicGenerationResponse({
      task_id: " task-url ",
      lyrics: "our city wakes",
      data: {
        audio: " https://example.com/url-audio.mp3 ",
      },
      base_resp: { status_code: 0 },
    });

    const provider = buildMinimaxMusicGenerationProvider();
    const result = await provider.generateMusic(musicRequest({ lyrics: "our city wakes" }));

    expectDownloadFetchTimeout("https://example.com/url-audio.mp3", 120_000);
    expect(result.tracks[0]?.buffer.byteLength).toBeGreaterThan(0);
    expect(result.lyrics).toEqual(["our city wakes"]);
    expect(result.metadata?.taskId).toBe("task-url");
    expect(result.metadata?.audioUrl).toBe("https://example.com/url-audio.mp3");
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
                `data: ${JSON.stringify({
                  data: { status: 2, audio: Buffer.from("late-mp3").toString("hex") },
                  base_resp: { status_code: 0 },
                })}`,
              ),
            );
            controller.close();
          }, 200);
        },
        cancel() {
          cancelled = true;
        },
      });
      postJsonRequestMock.mockResolvedValue({
        response: new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        }),
        release: vi.fn(async () => {}),
      });

      const provider = buildMinimaxMusicGenerationProvider();
      const generation = provider.generateMusic(musicRequest({ timeoutMs: 50 }));
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
    const provider = buildMinimaxMusicGenerationProvider();

    await expect(
      provider.generateMusic(
        musicRequest({ prompt: "driving techno", instrumental: true, lyrics: "do not sing this" }),
      ),
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
      base_resp: { status_code: 0 },
    });
    fetchWithTimeoutMock.mockRejectedValueOnce(new Error("request timeout")).mockResolvedValueOnce({
      headers: new Headers({ "content-type": "audio/mpeg" }),
      arrayBuffer: async () => Buffer.from("mp3-bytes"),
    });

    const provider = buildMinimaxMusicGenerationProvider("minimax-portal");
    const result = await provider.generateMusic(
      musicRequest({
        provider: "minimax-portal",
        prompt: "upbeat dance-pop",
        cfg: {
          models: {
            providers: {
              "minimax-portal": {
                baseUrl: "https://api.minimaxi.com",
                models: [],
                request: requestOverrides,
              },
            },
          },
        },
      }),
    );

    expectAllowPrivateNetworkPolicy(
      expectMinimaxGuardedFetchCall(0, "https://example.com/retry.mp3").options,
    );
    expectAllowPrivateNetworkPolicy(
      expectMinimaxGuardedFetchCall(1, "https://example.com/retry.mp3").options,
    );
    expect(result.tracks).toHaveLength(1);
    expect(
      executeProviderOperationWithRetryMock.mock.calls.map(
        ([params]) => (params as { stage: string }).stage,
      ),
    ).toContain("download");
  });
});

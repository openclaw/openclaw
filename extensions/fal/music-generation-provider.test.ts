import type { MusicGenerationRequest } from "openclaw/plugin-sdk/music-generation";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  requireFirstPostJsonRecordRequest,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createClosedChunkStream } from "../test-support/streaming-error-response.js";
import { buildFalMusicGenerationProvider } from "./music-generation-provider.js";

const { postJsonRequestMock, resolveApiKeyForProviderMock } = getProviderHttpMocks();

installProviderHttpMockCleanup();

function mockAudio(payload: unknown, body: BodyInit = "wav-bytes", contentType = "audio/wav") {
  postJsonRequestMock.mockResolvedValue({
    response: Response.json(payload),
    release: vi.fn(async () => {}),
  });
  const response = new Response(body, { headers: { "content-type": contentType } });
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function generateMusic(overrides: Partial<MusicGenerationRequest>) {
  return buildFalMusicGenerationProvider().generateMusic({
    provider: "fal",
    model: "fal-ai/minimax-music/v2.6",
    prompt: "city pop chorus",
    cfg: {},
    ...overrides,
  });
}

function expectRequest(model: string, body: Record<string, unknown>) {
  const request = requireFirstPostJsonRecordRequest(postJsonRequestMock, "fal music request");
  expect(request.url).toBe(`https://fal.run/fal-ai/${model}`);
  expect(request.body).toEqual(body);
}

beforeEach(async () => {
  const { fetchWithTimeout } = await import("openclaw/plugin-sdk/provider-http");
  resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "fal-key" });
  vi.mocked(fetchWithTimeout).mockImplementation((url, init, _timeoutMs, fetchFn = fetch) =>
    fetchFn(url, init),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("submits MiniMax music through fal and downloads the generated track", async () => {
  const url = "https://v3b.fal.media/files/b/kangaroo/out.mp3";
  const fetchMock = mockAudio(
    { audio: { url, content_type: "audio/mpeg", file_name: "out.mp3" } },
    "mp3-bytes",
    "application/octet-stream",
  );

  const result = await generateMusic({
    model: "",
    lyrics: "[Verse]\nNeon rain",
    durationSeconds: 42,
    format: "mp3",
  });

  expectRequest("minimax-music/v2.6", {
    prompt: "city pop chorus",
    lyrics: "[Verse]\nNeon rain",
    duration: 42,
    audio_setting: { sample_rate: 44100, bitrate: 256000, format: "mp3" },
  });
  expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ method: "GET" }));
  expect(result).toMatchObject({
    model: "fal-ai/minimax-music/v2.6",
    metadata: { audioUrl: url },
  });
  expect(result.tracks[0]).toMatchObject({
    mimeType: "audio/mpeg",
    fileName: "out.mp3",
  });
  expect(result.tracks[0]?.buffer).toEqual(Buffer.from("mp3-bytes"));
});

it("rejects generated music downloads that exceed the configured media cap", async () => {
  mockAudio(
    {
      audio: { url: "https://v3b.fal.media/files/b/out.mp3", content_type: "audio/mpeg" },
    },
    createClosedChunkStream([new TextEncoder().encode("too-large")]),
    "audio/mpeg",
  );

  await expect(
    generateMusic({
      prompt: "short track",
      cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
    }),
  ).rejects.toThrow("fal generated music download exceeds 1 bytes");
});

it("rejects MiniMax lyrics requests that also ask for instrumental output", async () => {
  await expect(generateMusic({ lyrics: "[Verse]\nNeon rain", instrumental: true })).rejects.toThrow(
    "fal MiniMax music generation cannot use lyrics when instrumental=true.",
  );

  expect(postJsonRequestMock).not.toHaveBeenCalled();
});

it.each([
  {
    model: "ace-step/prompt-to-audio",
    prompt: "lofi beach loop",
    options: { instrumental: true, durationSeconds: 30 },
    expected: { instrumental: true, duration: 30 },
    payload: {
      audio: { url: "https://example.com/out.wav", content_type: "audio/wav" },
      seed: 42,
      tags: "lofi, chill",
    },
  },
  {
    model: "stable-audio-25/text-to-audio",
    prompt: "orchestral hit",
    options: { durationSeconds: 12 },
    expected: { seconds_total: 12 },
    payload: { audio: "https://example.com/stable.wav" },
  },
])(
  "maps $model duration and instrumental controls",
  async ({ model, prompt, options, expected, payload }) => {
    mockAudio(payload);
    await generateMusic({ model: `fal-ai/${model}`, prompt, ...options });
    expectRequest(model, { prompt, ...expected });
  },
);

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

const prompt = "city pop chorus";
const audioUrl = "https://v3b.fal.media/files/b/out.mp3";

function generateMusic(overrides: Partial<MusicGenerationRequest>) {
  return buildFalMusicGenerationProvider().generateMusic({
    provider: "fal",
    model: "fal-ai/minimax-music/v2.6",
    prompt,
    cfg: {},
    ...overrides,
  });
}

function expectRequest(model: string, body: Record<string, unknown>) {
  const request = requireFirstPostJsonRecordRequest(postJsonRequestMock, "fal music request");
  expect(request.url).toBe(`https://fal.run/fal-ai/${model}`);
  expect(request.body).toEqual({ prompt, ...body });
}

beforeEach(async () => {
  const { fetchWithTimeout } = await import("openclaw/plugin-sdk/provider-http");
  resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "fal-key" });
  vi.mocked(fetchWithTimeout).mockImplementation((url, init, _timeoutMs, fetchFn = fetch) =>
    fetchFn(url, init),
  );
});

afterEach(() => vi.unstubAllGlobals());

it("submits MiniMax music through fal and downloads the generated track", async () => {
  const fetchMock = mockAudio(
    { audio: { url: audioUrl, content_type: "audio/mpeg", file_name: "out.mp3" } },
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
    lyrics: "[Verse]\nNeon rain",
    duration: 42,
    audio_setting: { sample_rate: 44100, bitrate: 256000, format: "mp3" },
  });
  expect(fetchMock).toHaveBeenCalledWith(audioUrl, expect.objectContaining({ method: "GET" }));
  expect(result).toMatchObject({
    model: "fal-ai/minimax-music/v2.6",
    metadata: { audioUrl },
    tracks: [expect.objectContaining({ mimeType: "audio/mpeg", fileName: "out.mp3" })],
  });
  expect(result.tracks[0]?.buffer).toEqual(Buffer.from("mp3-bytes"));
});

it("rejects generated music downloads that exceed the configured media cap", async () => {
  mockAudio(
    { audio: { url: audioUrl, content_type: "audio/mpeg" } },
    createClosedChunkStream([new TextEncoder().encode("too-large")]),
    "audio/mpeg",
  );

  await expect(
    generateMusic({
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

it("maps ACE-Step duration and instrumental controls", async () => {
  mockAudio({ audio: { url: audioUrl, content_type: "audio/wav" }, seed: 42, tags: "lofi, chill" });
  await generateMusic({
    model: "fal-ai/ace-step/prompt-to-audio",
    instrumental: true,
    durationSeconds: 30,
  });
  expectRequest("ace-step/prompt-to-audio", { instrumental: true, duration: 30 });
});

it("maps Stable Audio duration", async () => {
  mockAudio({ audio: audioUrl });
  await generateMusic({ model: "fal-ai/stable-audio-25/text-to-audio", durationSeconds: 12 });
  expectRequest("stable-audio-25/text-to-audio", { seconds_total: 12 });
});

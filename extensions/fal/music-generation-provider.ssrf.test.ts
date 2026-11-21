import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { SsrFBlockedError } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { buildFalMusicGenerationProvider } from "./music-generation-provider.js";

const apiUrl = "https://fal.run/fal-ai/minimax-music/v2.6";
const audioUrl = "https://v3b.fal.media/files/out.mp3";

function requestUrl(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : input.toString();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function serveAudio(url = audioUrl, response = new Response("mp3-bytes")) {
  vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
    apiKey: "synthetic-fal-key",
    source: "env",
    mode: "api-key",
  });
  const fetchMock = vi.fn<typeof fetch>(async (input) =>
    requestUrl(input) === apiUrl ? Response.json({ audio_file: { url } }) : response,
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function generateMusic() {
  return buildFalMusicGenerationProvider().generateMusic({
    provider: "fal",
    model: "fal-ai/minimax-music/v2.6",
    prompt: "instrumental synth melody",
    cfg: {},
  });
}

it.each([
  "http://127.0.0.1/private-audio",
  "http://169.254.169.254/private-audio",
  "http://[::1]/private-audio",
])("blocks a returned private audio destination before fetching it: %s", async (url) => {
  const fetchMock = serveAudio(url);

  await expect(generateMusic()).rejects.toBeInstanceOf(SsrFBlockedError);
  expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toEqual([apiUrl]);
});

it("blocks a public audio redirect to a private destination", async () => {
  const fetchMock = serveAudio(
    audioUrl,
    new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private-audio" } }),
  );

  await expect(generateMusic()).rejects.toBeInstanceOf(SsrFBlockedError);
  expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toEqual([apiUrl, audioUrl]);
  expect(fetchMock.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
});

it("downloads public audio without API credentials and releases its request", async () => {
  const fetchMock = serveAudio();

  const result = await generateMusic();

  expect(result.tracks[0]?.buffer).toEqual(Buffer.from("mp3-bytes"));
  expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toEqual([apiUrl, audioUrl]);
  const downloadInit = fetchMock.mock.calls[1]?.[1];
  expect(new Headers(downloadInit?.headers).has("authorization")).toBe(false);
  expect(downloadInit?.signal?.aborted).toBe(true);
});

it("preserves HTTP download errors and releases their request", async () => {
  const fetchMock = serveAudio(audioUrl, new Response("asset unavailable", { status: 404 }));

  await expect(generateMusic()).rejects.toThrow("fal generated music download failed (HTTP 404)");
  expect(fetchMock.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
});

it("retries a transient asset error without submitting another generation", async () => {
  vi.useFakeTimers();
  const fetchMock = serveAudio();
  fetchMock
    .mockResolvedValueOnce(Response.json({ audio_file: { url: audioUrl } }))
    .mockResolvedValueOnce(new Response("temporarily unavailable", { status: 503 }))
    .mockResolvedValueOnce(new Response("mp3-bytes"));

  const result = expect(generateMusic()).resolves.toMatchObject({
    tracks: [{ buffer: Buffer.from("mp3-bytes") }],
  });
  await vi.advanceTimersByTimeAsync(250);
  await result;
  expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toEqual([
    apiUrl,
    audioUrl,
    audioUrl,
  ]);
  for (const [, init] of fetchMock.mock.calls.slice(1)) {
    expect(init?.signal?.aborted).toBe(true);
  }
});

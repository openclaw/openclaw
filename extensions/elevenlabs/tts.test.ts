import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { synthesizeElevenLabsLiveSpeech } from "openclaw/plugin-sdk/provider-test-contracts";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import { MAX_AUDIO_BYTES } from "openclaw/plugin-sdk/speech-provider";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createClosedChunkStream,
  createStreamingResponse,
} from "../test-support/streaming-error-response.js";
import * as configApi from "./config-api.js";
import { buildElevenLabsSpeechProvider } from "./speech-provider-factory.js";

function mockFetch(response: Response) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  globalThis.fetch = fetchMock;
  return fetchMock;
}

function openAudioResponse(chunks: Uint8Array[], init?: ResponseInit) {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk));
    },
    cancel,
  });
  return { cancel, response: new Response(stream, init) };
}

describe("elevenlabs tts diagnostics", () => {
  installPinnedHostnameTestHooks();
  const originalFetch = globalThis.fetch;
  const provider = buildElevenLabsSpeechProvider({ formatErrorMessage });
  const streamSynthesize = expectDefined(provider.streamSynthesize, "streamSynthesize");
  beforeEach(() => {
    vi.spyOn(configApi, "resolveElevenLabsApiKeyWithProfileFallback").mockReturnValue(null);
  });
  const request: Parameters<typeof provider.synthesize>[0] = {
    text: "hello",
    cfg: {},
    providerConfig: { apiKey: "test-key" },
    target: "audio-file",
    timeoutMs: 5_000,
  };

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });
  it("includes raw non-JSON error detail while capping streamed body reads", async () => {
    const body = createStreamingResponse({
      status: 503,
      chunkCount: 200,
      chunkSize: 1024,
      byte: 121,
    });
    mockFetch(body.response);
    await expect(provider.synthesize(request)).rejects.toThrow("ElevenLabs API error (503): yyyy");
    expect(body.getReadCount()).toBeLessThan(200);
  });

  it("rejects JSON success from streaming TTS as malformed audio", async () => {
    mockFetch(Response.json({ error: "not audio" }));
    await expect(streamSynthesize(request)).rejects.toThrow(
      "ElevenLabs API error: malformed audio response",
    );
  });

  it("uses the streaming endpoint without buffering the audio body", async () => {
    const chunk = new Uint8Array([1, 2, 3]);
    const audioStream = createClosedChunkStream([chunk]);
    const fetchMock = mockFetch(new Response(audioStream));
    const result = await streamSynthesize({
      ...request,
      providerOverrides: { outputFormat: "mp3_44100_128", latencyTier: 2 },
    });
    const release = expectDefined(result.release, "ElevenLabs stream release");
    try {
      const [requestUrl, init] = expectDefined(fetchMock.mock.calls[0], "ElevenLabs fetch call");
      const url = new URL(resolveRequestUrl(requestUrl));
      expect(url.pathname).toBe("/v1/text-to-speech/pMsXgVXv3BLzUgSXRplE/stream");
      expect(url.searchParams.get("optimize_streaming_latency")).toBe("2");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(
        '{"text":"hello","model_id":"eleven_multilingual_v2","voice_settings":{"stability":0.5,"similarity_boost":0.75,"style":0,"use_speaker_boost":true,"speed":1}}',
      );
      expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
        accept: "audio/mpeg",
        "content-type": "application/json",
        "xi-api-key": "test-key",
      });
      const reader = result.audioStream.getReader();
      await expect(reader.read()).resolves.toEqual({ done: false, value: chunk });
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
      expect(audioStream.locked).toBe(false);
    } finally {
      await release();
    }
  });

  it("cancels streamed audio before delivering bytes beyond the audio limit", async () => {
    const { cancel, response } = openAudioResponse(
      [new Uint8Array(MAX_AUDIO_BYTES), new Uint8Array([1])],
      {
        headers: { "content-type": "audio/mpeg" },
      },
    );
    mockFetch(response);
    const result = await streamSynthesize(request);
    const release = expectDefined(result.release, "ElevenLabs stream release");
    try {
      const reader = result.audioStream.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(first.value).toHaveLength(MAX_AUDIO_BYTES);
      await expect(reader.read()).rejects.toThrow(
        `ElevenLabs API error: audio response exceeds ${MAX_AUDIO_BYTES} bytes`,
      );
      expect(cancel).toHaveBeenCalledOnce();
      expect(response.body?.locked).toBe(false);
    } finally {
      await release();
    }
  });

  it("cancels the live helper error body when ElevenLabs returns non-2xx", async () => {
    const { cancel, response } = openAudioResponse([new Uint8Array([1, 2, 3])], { status: 401 });
    mockFetch(response);
    await expect(
      synthesizeElevenLabsLiveSpeech({
        text: "OpenClaw leak check.",
        apiKey: "x",
        outputFormat: "mp3_44100_128",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("ElevenLabs live TTS failed (401)");
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.bodyUsed).toBe(true);
  });
});

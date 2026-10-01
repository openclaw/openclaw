import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { synthesizeElevenLabsLiveSpeech } from "openclaw/plugin-sdk/provider-test-contracts";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import { MAX_AUDIO_BYTES } from "openclaw/plugin-sdk/speech-provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStreamingErrorResponse } from "../test-support/streaming-error-response.js";
import { elevenLabsTTS, elevenLabsTTSStream } from "./tts.js";

function mockFetch(response: Response) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  globalThis.fetch = fetchMock;
  return fetchMock;
}

describe("elevenlabs tts diagnostics", () => {
  const originalFetch = globalThis.fetch;

  function createDefaultTtsRequest() {
    return {
      text: "hello",
      apiKey: "test-key",
      baseUrl: "https://api.elevenlabs.io",
      voiceId: "pMsXgVXv3BLzUgSXRplE",
      modelId: "eleven_multilingual_v2",
      outputFormat: "mp3_44100_128",
      voiceSettings: {
        stability: 0.5,
        similarityBoost: 0.75,
        style: 0,
        useSpeakerBoost: true,
        speed: 1,
      },
      timeoutMs: 5_000,
    };
  }

  async function expectDefaultTtsRequestToThrow(message: string | RegExp) {
    await expect(elevenLabsTTS(createDefaultTtsRequest())).rejects.toThrow(message);
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("includes parsed provider detail and request id for JSON API errors", async () => {
    mockFetch(
      Response.json(
        { detail: { message: "Quota exceeded", status: "quota_exceeded" } },
        { status: 429, headers: { "x-request-id": "el_req_456" } },
      ),
    );

    await expectDefaultTtsRequestToThrow(
      "ElevenLabs API error (429): Quota exceeded [code=quota_exceeded] [request_id=el_req_456]",
    );
  });

  it("includes raw non-JSON error detail while capping streamed body reads", async () => {
    const streamed = createStreamingErrorResponse({
      status: 503,
      chunkCount: 200,
      chunkSize: 1024,
      byte: 121,
    });
    mockFetch(streamed.response);

    await expectDefaultTtsRequestToThrow("ElevenLabs API error (503): yyyy");

    expect(streamed.getReadCount()).toBeLessThan(200);
  });

  it.each([
    { name: "buffered TTS", synthesize: elevenLabsTTS },
    { name: "streaming TTS", synthesize: elevenLabsTTSStream },
  ])("rejects JSON success from $name as malformed audio", async ({ synthesize }) => {
    mockFetch(Response.json({ error: "not audio" }));
    await expect(synthesize(createDefaultTtsRequest())).rejects.toThrow(
      "ElevenLabs API error: malformed audio response",
    );
  });

  it("rejects empty successful audio bodies as malformed audio", async () => {
    mockFetch(new Response(new Uint8Array()));

    await expectDefaultTtsRequestToThrow("ElevenLabs API error: malformed audio response");
  });

  it("omits the MPEG Accept header for PCM telephony output", async () => {
    const fetchMock = mockFetch(new Response(Buffer.from("pcm")));

    await elevenLabsTTS({
      ...createDefaultTtsRequest(),
      outputFormat: "pcm_22050",
    });

    const [, init] = expectDefined(fetchMock.mock.calls[0], "ElevenLabs fetch call");
    const headers = new Headers(expectDefined(init, "ElevenLabs request init").headers);
    expect(headers.has("accept")).toBe(false);
  });

  it("rejects fractional latency optimization instead of truncating it", async () => {
    const fetchMock = mockFetch(new Response(Buffer.from("mp3")));

    await expect(
      elevenLabsTTS({
        ...createDefaultTtsRequest(),
        latencyTier: 3.9,
      }),
    ).rejects.toThrow("latencyTier must be an integer");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("omits latency optimization for eleven_v3 because the API rejects it", async () => {
    const fetchMock = mockFetch(new Response(Buffer.from("mp3")));

    await elevenLabsTTS({
      ...createDefaultTtsRequest(),
      modelId: "eleven_v3",
      latencyTier: 3,
    });

    const [requestUrl] = expectDefined(fetchMock.mock.calls[0], "ElevenLabs fetch call");
    const url = new URL(resolveRequestUrl(requestUrl));
    expect(url.searchParams.has("optimize_streaming_latency")).toBe(false);
  });

  it("uses the streaming endpoint without buffering the audio body", async () => {
    const audioStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const fetchMock = mockFetch(new Response(audioStream));

    const result = await elevenLabsTTSStream({
      ...createDefaultTtsRequest(),
      latencyTier: 2,
    });
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
      await expect(reader.read()).resolves.toEqual({
        done: false,
        value: new Uint8Array([1, 2, 3]),
      });
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
      expect(audioStream.locked).toBe(false);
    } finally {
      await result.release();
    }
  });

  it("cancels streamed audio before delivering bytes beyond the audio limit", async () => {
    const cancel = vi.fn();
    const audioStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_AUDIO_BYTES));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel,
    });
    mockFetch(new Response(audioStream, { headers: { "content-type": "audio/mpeg" } }));

    const result = await elevenLabsTTSStream(createDefaultTtsRequest());
    try {
      const reader = result.audioStream.getReader();

      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(first.value).toHaveLength(MAX_AUDIO_BYTES);
      await expect(reader.read()).rejects.toThrow(
        `ElevenLabs API error: audio response exceeds ${MAX_AUDIO_BYTES} bytes`,
      );
      expect(cancel).toHaveBeenCalledOnce();
      expect(audioStream.locked).toBe(false);
    } finally {
      await result.release();
    }
  });

  it("cancels the live helper error body when ElevenLabs returns non-2xx", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
        cancel,
      }),
      { status: 401 },
    );
    globalThis.fetch = vi.fn<typeof fetch>(async () => response);

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

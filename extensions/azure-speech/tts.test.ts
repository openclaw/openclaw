import { withServer } from "openclaw/plugin-sdk/test-env";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../test-support/streaming-error-response.js";
import {
  azureSpeechTTS,
  inferAzureSpeechFileExtension,
  isAzureSpeechVoiceCompatible,
  listAzureSpeechVoices,
} from "./tts.js";

describe("azure speech tts", () => {
  installPinnedHostnameTestHooks();
  const synthesisRequest = {
    text: "hello",
    apiKey: "fixture-value",
    region: "eastus",
    voice: "en-US-JennyNeural",
    lang: "en-US",
    outputFormat: "audio-24khz-48kbitrate-mono-mp3",
    timeoutMs: 1234,
  };
  const voiceRequest = { apiKey: "speech-key", baseUrl: "https://custom.example.com/" };
  const synthesize = (overrides: Partial<Parameters<typeof azureSpeechTTS>[0]> = {}) =>
    azureSpeechTTS({ ...synthesisRequest, ...overrides });
  const expectMalformedAudio = (overrides: Partial<Parameters<typeof azureSpeechTTS>[0]>) =>
    expect(synthesize(overrides)).rejects.toThrow(
      "Azure Speech TTS API error: malformed audio response",
    );
  function mockResponse(response: Response) {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  const mockVoiceCatalog = (payload: unknown) =>
    mockResponse(
      new Response(JSON.stringify(payload), {
        headers: { "Content-Type": "application/json" },
      }),
    );

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("maps Azure output formats to attachment metadata", () => {
    expect(inferAzureSpeechFileExtension("audio-24khz-48kbitrate-mono-mp3")).toBe(".mp3");
    expect(inferAzureSpeechFileExtension("ogg-24khz-16bit-mono-opus")).toBe(".ogg");
    expect(inferAzureSpeechFileExtension("riff-24khz-16bit-mono-pcm")).toBe(".wav");
    expect(inferAzureSpeechFileExtension("raw-8khz-8bit-mono-mulaw")).toBe(".pcm");
    expect(inferAzureSpeechFileExtension("webm-24khz-16bit-mono-opus")).toBe(".webm");
    expect(inferAzureSpeechFileExtension("amr-wb-16000hz")).toBe(".amr");
    expect(inferAzureSpeechFileExtension("RIFF-24KHZ-16BIT-MONO-PCM")).toBe(".wav");
    expect(inferAzureSpeechFileExtension("ogg-mp3")).toBe(".mp3");
    expect(inferAzureSpeechFileExtension("unknown")).toBe(".audio");
    expect(isAzureSpeechVoiceCompatible("ogg-24khz-16bit-mono-opus")).toBe(true);
    expect(isAzureSpeechVoiceCompatible("webm-24khz-16bit-mono-opus")).toBe(false);
  });

  it("posts SSML to the region endpoint with Azure Speech headers", async () => {
    const fetchMock = mockResponse(new Response(Buffer.from("mp3"), { status: 200 }));
    const result = await synthesize({
      text: `Tom & "Jerry" <tag>`,
      voice: `en-US-JennyNeural" xml:lang="evil`,
      lang: `en-US" bad="1`,
    });
    expect(result).toEqual(Buffer.from("mp3"));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://eastus.tts.speech.microsoft.com/cognitiveservices/v1");
    expect(init.method).toBe("POST");
    expect(Object.fromEntries(new Headers(init.headers))).toMatchObject({
      "ocp-apim-subscription-key": "fixture-value",
      "content-type": "application/ssml+xml",
      "x-microsoft-outputformat": "audio-24khz-48kbitrate-mono-mp3",
    });
    expect(init.body).toBe(
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US&quot; bad=&quot;1"><voice name="en-US-JennyNeural&quot; xml:lang=&quot;evil">Tom &amp; "Jerry" &lt;tag&gt;</voice></speak>`,
    );
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("caps streamed audio responses instead of buffering oversized TTS output", async () => {
    const streamed = createStreamingResponse({
      chunkCount: 20,
      chunkSize: 1024,
      byte: 121,
      headers: { "Content-Type": "audio/mpeg" },
    });
    mockResponse(streamed.response);
    await expect(synthesize({ apiKey: "speech-key", maxBytes: 2048 })).rejects.toThrow(
      "Azure Speech TTS audio response exceeds 2048 bytes",
    );
    expect(streamed.getReadCount()).toBeLessThan(20);
  });

  it("lists valid voices while filtering deprecated and malformed entries", async () => {
    const voice = {
      ShortName: "en-US-JennyNeural",
      DisplayName: "Jenny",
      Locale: "en-US",
      Gender: "Female",
      Status: "GA",
      VoiceTag: { VoicePersonalities: ["Warm"] },
    };
    const fetchMock = mockVoiceCatalog([
      voice,
      { ShortName: "en-US-OldNeural", DisplayName: "Old", Status: "Deprecated" },
      { ShortName: "en-US-RetiredNeural", DisplayName: "Retired", IsDeprecated: true },
      null,
      "unexpected",
      [],
      { ShortName: 42 },
      {
        ...voice,
        ShortName: "en-US-AriaNeural",
        DisplayName: "Aria",
        VoiceTag: {
          TailoredScenarios: [null, "Conversational"],
          VoicePersonalities: [false, "Warm", "  "],
        },
      },
    ]);

    const voices = await listAzureSpeechVoices({ ...voiceRequest, timeoutMs: 4321 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://custom.example.com/cognitiveservices/voices/list");
    expect(new Headers(init.headers).get("Ocp-Apim-Subscription-Key")).toBe("speech-key");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const metadata = { locale: "en-US", gender: "Female", personalities: ["Warm"] };
    expect(voices).toEqual([
      { ...metadata, id: "en-US-JennyNeural", name: "Jenny", description: "Warm" },
      { ...metadata, id: "en-US-AriaNeural", name: "Aria", description: "Conversational, Warm" },
    ]);
  });

  it("returns an empty catalog for a malformed top-level voice payload", async () => {
    mockVoiceCatalog(null);
    await expect(listAzureSpeechVoices(voiceRequest)).resolves.toEqual([]);
  });

  it("rejects empty synthesized audio", async () => {
    mockResponse(new Response("", { headers: { "content-type": "audio/mpeg" } }));
    await expectMalformedAudio({ timeoutMs: 5_000 });
  });

  it("closes the upstream socket for a never-ending malformed response over a real connection", async () => {
    const { promise: socketClosed, resolve: notifySocketClosed } = Promise.withResolvers<boolean>();
    await withServer(
      (request, response) => {
        request.socket.once("close", () => notifySocketClosed(true));
        response.writeHead(200, { "content-type": "application/json" });
        // Headers land, then the body never ends: only an explicit cancel closes this.
        response.write('{"error":"still streaming');
      },
      async (baseUrl) => {
        await expectMalformedAudio({
          endpoint: baseUrl,
          outputFormat: undefined,
          timeoutMs: 5_000,
        });
        await expect(
          withTimeout(socketClosed, 250, {
            message: "Azure Speech malformed-response socket did not close",
          }),
        ).resolves.toBe(true);
      },
    );
  });
});

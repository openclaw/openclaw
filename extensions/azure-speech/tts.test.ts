import { expectDefined } from "@openclaw/normalization-core";
import { jsonResponse, withServer } from "openclaw/plugin-sdk/test-env";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../test-support/streaming-error-response.js";
import { buildAzureSpeechProvider } from "./speech-provider.js";

describe("azure speech tts", () => {
  installPinnedHostnameTestHooks();
  const provider = buildAzureSpeechProvider();
  const listVoices = expectDefined(provider.listVoices, "Azure voice-list provider");
  const voiceRequest = { apiKey: "speech-key", baseUrl: "https://custom.example.com/" };
  type SynthesisOverrides = {
    apiKey?: string;
    endpoint?: string;
    voice?: string;
    lang?: string;
    outputFormat?: string;
    text?: string;
    timeoutMs?: number;
    maxBytes?: number;
  };
  const synthesize = (overrides: SynthesisOverrides = {}) => {
    const { text = "hello", timeoutMs = 1234, maxBytes, ...config } = overrides;
    return provider.synthesize({
      text,
      timeoutMs,
      providerConfig: { apiKey: "fixture-value", region: "eastus", ...config },
      target: "audio-file",
      cfg:
        maxBytes === undefined
          ? {}
          : { agents: { defaults: { mediaMaxMb: maxBytes / (1024 * 1024) } } },
    });
  };
  const expectMalformedAudio = (overrides: SynthesisOverrides) =>
    expect(synthesize(overrides)).rejects.toThrow(
      "Azure Speech TTS API error: malformed audio response",
    );
  function mockResponse(response: Response) {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  const mockVoiceCatalog = (payload: unknown) => mockResponse(jsonResponse(payload));

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("maps Azure output formats to attachment metadata", async () => {
    for (const [outputFormat, fileExtension, voiceCompatible] of [
      ["ogg-24khz-16bit-mono-opus", ".ogg", true],
      ["raw-8khz-8bit-mono-mulaw", ".pcm", false],
      ["webm-24khz-16bit-mono-opus", ".webm", false],
      ["amr-wb-16000hz", ".amr", false],
      ["RIFF-24KHZ-16BIT-MONO-PCM", ".wav", false],
      ["ogg-mp3", ".mp3", false],
      ["unknown", ".audio", false],
    ] satisfies Array<[string, string, boolean]>) {
      mockResponse(new Response(Buffer.from("mp3"), { headers: { "Content-Type": "audio/mpeg" } }));
      await expect(synthesize({ outputFormat })).resolves.toMatchObject({
        outputFormat,
        fileExtension,
        voiceCompatible,
      });
    }
  });

  it("escapes SSML text and attributes and sends the XML content type", async () => {
    const fetchMock = mockResponse(new Response(Buffer.from("mp3")));
    await synthesize({
      text: `Tom & "Jerry" <tag>`,
      voice: `en-US-JennyNeural" xml:lang="evil`,
      lang: `en-US" bad="1`,
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("content-type")).toBe("application/ssml+xml");
    expect(init.body).toBe(
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US&quot; bad=&quot;1"><voice name="en-US-JennyNeural&quot; xml:lang=&quot;evil">Tom &amp; "Jerry" &lt;tag&gt;</voice></speak>`,
    );
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

    const voices = await listVoices(voiceRequest);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://custom.example.com/cognitiveservices/voices/list");
    expect(new Headers(init.headers).get("Ocp-Apim-Subscription-Key")).toBe("speech-key");
    const metadata = { locale: "en-US", gender: "Female", personalities: ["Warm"] };
    expect(voices).toEqual([
      { ...metadata, id: "en-US-JennyNeural", name: "Jenny", description: "Warm" },
      { ...metadata, id: "en-US-AriaNeural", name: "Aria", description: "Conversational, Warm" },
    ]);
  });

  it("returns an empty catalog for a malformed top-level voice payload", async () => {
    mockVoiceCatalog(null);
    await expect(listVoices(voiceRequest)).resolves.toEqual([]);
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

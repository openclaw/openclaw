import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../test-support/streaming-error-response.js";
import { buildSpeechifySpeechProvider } from "./speech-provider.js";

describe("speechify speech provider", () => {
  installPinnedHostnameTestHooks();

  const provider = buildSpeechifySpeechProvider();
  const synthesizeTelephony = provider.synthesizeTelephony;
  const streamSynthesize = provider.streamSynthesize;
  if (!synthesizeTelephony || !streamSynthesize) {
    throw new Error("Expected Speechify provider telephony and streaming synthesis");
  }
  const request: SpeechSynthesisRequest = {
    text: "OpenClaw test",
    cfg: {},
    providerConfig: { apiKey: "sk_test123" },
    target: "audio-file",
    timeoutMs: 30_000,
  };

  const firstFetchCall = (fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] => {
    const call = fetchMock.mock.calls[0] as [string, RequestInit] | undefined;
    if (!call) {
      throw new Error("expected Speechify fetch call");
    }
    return call;
  };
  const requestBody = (init: RequestInit) => JSON.parse(init.body as string);

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reports not configured without a key or with an invalid baseUrl", async () => {
    vi.stubEnv("SPEECHIFY_API_KEY", undefined);
    expect(await provider.isConfiguredAsync?.({ providerConfig: {}, timeoutMs: 5_000 })).toBe(
      false,
    );
    expect(
      await provider.isConfiguredAsync?.({
        providerConfig: { apiKey: "sk_test123", baseUrl: "https://example.com" },
        timeoutMs: 5_000,
      }),
    ).toBe(false);
    expect(
      await provider.isConfiguredAsync?.({
        providerConfig: { apiKey: "sk_test123" },
        timeoutMs: 5_000,
      }),
    ).toBe(true);
  });

  it("synthesizes MP3 via the Speechify streaming endpoint with the defaults", async () => {
    const audioData = Buffer.from("mp3-audio-data");
    const fetchMock = vi.fn().mockResolvedValue(new Response(audioData, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider.synthesize(request);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = firstFetchCall(fetchMock);
    expect(url).toBe("https://api.speechify.ai/v1/audio/stream");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk_test123");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("audio/mpeg");
    expect(headers.get("speechify-caller")).toBe("openclaw");
    expect(headers.get("speechify-caller-version")).toMatch(/^\d{4}\.\d+\.\d+/);
    expect(requestBody(init)).toEqual({
      input: "OpenClaw test",
      voice_id: "geffen_32",
      model: "simba-3.2",
    });
    expect(result).toMatchObject({
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: false,
    });
    expect(result.audioBuffer).toEqual(audioData);
  });

  it("sends configured voice, model and language, letting overrides win", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from("a"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await provider.synthesize({
      ...request,
      providerConfig: {
        apiKey: "sk_test123",
        speakerVoiceId: "cristiane",
        model: "simba-3.0",
        language: "pt-BR",
      },
      providerOverrides: { voiceId: "bruno" },
    });

    expect(requestBody(firstFetchCall(fetchMock)[1])).toEqual({
      input: "OpenClaw test",
      voice_id: "bruno",
      model: "simba-3.0",
      language: "pt-BR",
    });
  });

  it("rejects untrusted Speechify baseUrl config before dispatching the API key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(Buffer.from("audio"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      provider.synthesize({
        ...request,
        providerConfig: { apiKey: "sk_test123", baseUrl: "https://example.com" },
      }),
    ).rejects.toThrow("Speechify baseUrl must target api.speechify.ai");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests Ogg Opus and marks voice notes voice-compatible", async () => {
    const audioData = Buffer.from("ogg-audio-data");
    const fetchMock = vi.fn().mockResolvedValue(new Response(audioData, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider.synthesize({ ...request, target: "voice-note" });

    expect(new Headers(firstFetchCall(fetchMock)[1].headers).get("accept")).toBe("audio/ogg");
    expect(result).toMatchObject({
      outputFormat: "ogg",
      fileExtension: ".ogg",
      voiceCompatible: true,
    });
    expect(result.audioBuffer).toEqual(audioData);
  });

  it("streams audio as it arrives", async () => {
    const streamed = createStreamingResponse({ chunkCount: 3, chunkSize: 2, byte: 7 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamed.response));

    const result = await streamSynthesize({ ...request, target: "voice-note" });

    expect(result).toMatchObject({
      outputFormat: "ogg",
      fileExtension: ".ogg",
      voiceCompatible: true,
    });
    const bytes = new Uint8Array(await new Response(result.audioStream).arrayBuffer());
    expect([...bytes]).toEqual([7, 7, 7, 7, 7, 7]);
    await result.release?.();
  });

  it("applies the configured media byte cap to synthesized audio", async () => {
    const streamed = createStreamingResponse({ chunkCount: 20, chunkSize: 1024, byte: 121 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamed.response));

    await expect(
      provider.synthesize({
        ...request,
        cfg: { agents: { defaults: { mediaMaxMb: 0.001 } } },
      }),
    ).rejects.toThrow("Speechify TTS audio response exceeds 1048 bytes");
    expect(streamed.getReadCount()).toBeLessThan(20);
  });

  it("requests raw 24 kHz PCM for telephony", async () => {
    const audioData = Buffer.from("pcm-audio-data");
    const fetchMock = vi.fn().mockResolvedValue(new Response(audioData, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await synthesizeTelephony({
      ...request,
      text: "Telephony test",
      providerConfig: { apiKey: "sk_test123", voiceId: "default-voice" },
      providerOverrides: { voiceId: "override-voice" },
    });

    const [, init] = firstFetchCall(fetchMock);
    expect(new Headers(init.headers).get("accept")).toBe("audio/pcm");
    expect(requestBody(init)).toEqual({
      input: "Telephony test",
      voice_id: "override-voice",
      model: "simba-3.2",
    });
    expect(result).toEqual({ audioBuffer: audioData, outputFormat: "pcm", sampleRate: 24_000 });
  });

  it("rejects a blank environment key before normal or telephony requests", async () => {
    vi.stubEnv("SPEECHIFY_API_KEY", "   ");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await provider.isConfiguredAsync?.({ providerConfig: {}, timeoutMs: 5_000 })).toBe(
      false,
    );
    await expect(provider.synthesize({ ...request, providerConfig: {} })).rejects.toThrow(
      "Speechify API key missing",
    );
    await expect(synthesizeTelephony({ ...request, providerConfig: {} })).rejects.toThrow(
      "Speechify API key missing",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the environment key when config has none", async () => {
    vi.stubEnv("SPEECHIFY_API_KEY", "sk_from_env");
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from("a"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await provider.synthesize({ ...request, providerConfig: {} });

    expect(new Headers(firstFetchCall(fetchMock)[1].headers).get("authorization")).toBe(
      "Bearer sk_from_env",
    );
  });

  it("parses voice, model and language directive tokens under policy", () => {
    const policy = {
      enabled: true,
      allowProvider: true,
      allowText: true,
      allowVoice: true,
      allowModelId: false,
      allowVoiceSettings: true,
      allowNormalization: true,
      allowSeed: true,
    };
    const parse = (key: string, value: string) =>
      provider.parseDirectiveToken?.({ key, value, policy, currentOverrides: {} });

    expect(parse("voice", "bruno")).toEqual({ handled: true, overrides: { voiceId: "bruno" } });
    expect(parse("model", "simba-3.0")).toEqual({ handled: true });
    expect(parse("lang", "pt-BR")).toEqual({
      handled: true,
      overrides: { language: "pt-BR" },
    });
    expect(parse("speed", "1.2")).toEqual({ handled: false });
  });

  it("resolves Talk config and overrides onto the TTS config", () => {
    const providerConfig = provider.resolveTalkConfig?.({
      cfg: {},
      baseTtsConfig: { providers: { speechify: { apiKey: "sk_test123", model: "simba-3.0" } } },
      talkProviderConfig: { voiceId: "cristiane", language: "pt-BR" },
      timeoutMs: request.timeoutMs,
    });
    expect(providerConfig).toMatchObject({
      apiKey: "sk_test123",
      baseUrl: "https://api.speechify.ai",
      voiceId: "cristiane",
      model: "simba-3.0",
      language: "pt-BR",
    });
    expect(
      provider.resolveTalkOverrides?.({
        talkProviderConfig: {},
        params: { modelId: "simba-3.2", voiceId: "geffen_32" },
      }),
    ).toEqual({ voiceId: "geffen_32", model: "simba-3.2" });
  });
});

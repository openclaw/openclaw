import type { SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../test-support/streaming-error-response.js";
import { buildGradiumSpeechProvider } from "./speech-provider.js";

describe("gradium speech provider", () => {
  installPinnedHostnameTestHooks();

  const provider = buildGradiumSpeechProvider();
  const synthesizeTelephony = provider.synthesizeTelephony;
  if (!synthesizeTelephony) {
    throw new Error("Expected Gradium provider synthesizeTelephony");
  }
  const request: SpeechSynthesisRequest = {
    text: "OpenClaw test",
    cfg: {},
    providerConfig: { apiKey: "gsk_test123" },
    target: "audio-file",
    timeoutMs: 30_000,
  };

  const firstFetchCall = (fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] => {
    const call = fetchMock.mock.calls[0] as [string, RequestInit] | undefined;
    if (!call) {
      throw new Error("expected Gradium fetch call");
    }
    return call;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reports configured when GRADIUM_API_KEY is set", () => {
    vi.stubEnv("GRADIUM_API_KEY", "gsk_test");
    expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 5_000 })).toBe(true);
  });

  it("reports not configured for an invalid baseUrl instead of throwing", () => {
    vi.stubEnv("GRADIUM_API_KEY", undefined);
    expect(
      provider.isConfigured({
        providerConfig: { apiKey: String(true), baseUrl: "https://example.com" },
        timeoutMs: 5_000,
      }),
    ).toBe(false);
    expect(
      provider.isConfigured({
        providerConfig: { apiKey: String(true), baseUrl: "not-a-url" },
        timeoutMs: 5_000,
      }),
    ).toBe(false);
  });

  it("synthesizes audio via the Gradium TTS endpoint", async () => {
    const audioData = Buffer.from("wav-audio-data");
    const fetchMock = vi.fn().mockResolvedValue(new Response(audioData, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider.synthesize(request);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = firstFetchCall(fetchMock);
    expect(url).toBe("https://api.gradium.ai/api/post/speech/tts");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBe("gsk_test123");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      text: "OpenClaw test",
      voice_id: "YTpq7expH9539ERJ",
      only_audio: true,
      output_format: "wav",
      json_config: '{"padding_bonus":0}',
    });
    expect(result.outputFormat).toBe("wav");
    expect(result.fileExtension).toBe(".wav");
    expect(result.voiceCompatible).toBe(false);
    expect(result.audioBuffer).toEqual(audioData);
  });

  it("rejects untrusted Gradium baseUrl config before dispatching the API key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(Buffer.from("audio"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      provider.synthesize({
        ...request,
        providerConfig: { apiKey: "gsk_test123", baseUrl: "https://example.com" },
      }),
    ).rejects.toThrow("Gradium baseUrl must target api.gradium.ai");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses opus and voiceCompatible for voice-note target", async () => {
    const audioData = Buffer.from("opus-audio-data");
    const fetchMock = vi.fn().mockResolvedValue(new Response(audioData, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider.synthesize({ ...request, target: "voice-note" });

    const [, init] = firstFetchCall(fetchMock);
    expect(JSON.parse(init.body as string).output_format).toBe("opus");
    expect(result.outputFormat).toBe("opus");
    expect(result.fileExtension).toBe(".opus");
    expect(result.voiceCompatible).toBe(true);
    expect(result.audioBuffer).toEqual(audioData);
  });

  it("applies the configured media byte cap to synthesized audio", async () => {
    const streamed = createStreamingResponse({ chunkCount: 20, chunkSize: 1024, byte: 121 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamed.response));

    await expect(
      provider.synthesize({
        ...request,
        cfg: { agents: { defaults: { mediaMaxMb: 0.001 } } },
      }),
    ).rejects.toThrow("Gradium TTS audio response exceeds 1048 bytes");
    expect(streamed.getReadCount()).toBeLessThan(20);
  });

  it("uses ulaw_8000 for telephony synthesis", async () => {
    const audioData = Buffer.from("ulaw-audio-data");
    const fetchMock = vi.fn().mockResolvedValue(new Response(audioData, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await synthesizeTelephony({
      ...request,
      text: "Telephony test",
      providerConfig: { apiKey: "gsk_test123", voiceId: "default-voice" },
      providerOverrides: { voiceId: "override-voice" },
    });

    const [, init] = firstFetchCall(fetchMock);
    expect(JSON.parse(init.body as string)).toEqual({
      text: "Telephony test",
      voice_id: "override-voice",
      only_audio: true,
      output_format: "ulaw_8000",
      json_config: '{"padding_bonus":0}',
    });
    expect(result.outputFormat).toBe("ulaw_8000");
    expect(result.sampleRate).toBe(8_000);
    expect(result.audioBuffer).toEqual(audioData);
  });

  it("rejects a blank environment key before normal or telephony requests", async () => {
    vi.stubEnv("GRADIUM_API_KEY", "   ");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 5_000 })).toBe(false);
    await expect(provider.synthesize({ ...request, providerConfig: {} })).rejects.toThrow(
      "Gradium API key missing",
    );

    await expect(synthesizeTelephony({ ...request, providerConfig: {} })).rejects.toThrow(
      "Gradium API key missing",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

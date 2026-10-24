import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
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
  const audioData = Buffer.from("audio-data");
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(new Response(audioData, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  const firstFetchCall = (): [string, RequestInit] => {
    const call = fetchMock.mock.calls[0] as [string, RequestInit] | undefined;
    assert(call, "expected Gradium fetch call");
    return call;
  };
  const isConfigured = (providerConfig: SpeechSynthesisRequest["providerConfig"]) =>
    provider.isConfiguredAsync?.({ providerConfig, timeoutMs: 5_000 });
  const expectBody = (overrides: Record<string, unknown>) => {
    const [, init] = firstFetchCall();
    expect(JSON.parse(init.body as string)).toEqual({
      text: request.text,
      voice_id: "YTpq7expH9539ERJ",
      only_audio: true,
      json_config: '{"padding_bonus":0}',
      ...overrides,
    });
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reports not configured for an invalid baseUrl instead of throwing", async () => {
    vi.stubEnv("GRADIUM_API_KEY", undefined);
    expect(await isConfigured({ apiKey: "true", baseUrl: "https://example.com" })).toBe(false);
    expect(await isConfigured({ apiKey: "true", baseUrl: "not-a-url" })).toBe(false);
  });

  it.each([
    ["audio-file", "wav", false],
    ["voice-note", "opus", true],
  ] as const)(
    "synthesizes %s as %s via the Gradium TTS endpoint",
    async (target, format, voiceCompatible) => {
      const result = await provider.synthesize({ ...request, target });
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = firstFetchCall();
      expect(url).toBe("https://api.gradium.ai/api/post/speech/tts");
      expect(init.method).toBe("POST");
      expect(Object.fromEntries(new Headers(init.headers))).toMatchObject({
        "x-api-key": "gsk_test123",
        "content-type": "application/json",
      });
      expectBody({ output_format: format });
      expect(result).toMatchObject({
        outputFormat: format,
        fileExtension: `.${format}`,
        voiceCompatible,
      });
      expect(result.audioBuffer).toEqual(audioData);
    },
  );

  it("applies the configured media byte cap to synthesized audio", async () => {
    const streamed = createStreamingResponse({ chunkCount: 20, chunkSize: 1024, byte: 121 });
    fetchMock.mockResolvedValue(streamed.response);

    await expect(
      provider.synthesize({
        ...request,
        cfg: { agents: { defaults: { mediaMaxMb: 0.001 } } },
      }),
    ).rejects.toThrow("Gradium TTS audio response exceeds 1048 bytes");
    expect(streamed.getReadCount()).toBeLessThan(20);
  });

  it("uses ulaw_8000 for telephony synthesis", async () => {
    const result = await synthesizeTelephony({
      ...request,
      text: "Telephony test",
      providerConfig: { apiKey: "gsk_test123", voiceId: "default-voice" },
      providerOverrides: { voiceId: "override-voice" },
    });
    expectBody({
      text: "Telephony test",
      voice_id: "override-voice",
      output_format: "ulaw_8000",
    });
    expect(result).toMatchObject({
      outputFormat: "ulaw_8000",
      sampleRate: 8_000,
    });
    expect(result.audioBuffer).toEqual(audioData);
  });

  it("rejects a blank environment key before normal or telephony requests", async () => {
    vi.stubEnv("GRADIUM_API_KEY", "   ");
    const noKey = { ...request, providerConfig: {} };
    expect(await isConfigured({})).toBe(false);
    await expect(provider.synthesize(noKey)).rejects.toThrow("Gradium API key missing");
    await expect(synthesizeTelephony(noKey)).rejects.toThrow("Gradium API key missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

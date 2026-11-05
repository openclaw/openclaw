import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../test-support/streaming-error-response.js";
import { buildGradiumSpeechProvider } from "./speech-provider.js";

describe("gradium speech provider", () => {
  installPinnedHostnameTestHooks();

  const provider = buildGradiumSpeechProvider();
  const synthesizeTelephony = provider.synthesizeTelephony;
  assert(synthesizeTelephony, "Expected Gradium provider synthesizeTelephony");
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
  const expectRequest = (overrides: Record<string, unknown>) => {
    const call = fetchMock.mock.calls[0] as [string, RequestInit] | undefined;
    assert(call, "expected Gradium fetch call");
    const [url, init] = call;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(url).toBe("https://api.gradium.ai/api/post/speech/tts");
    expect(init.method).toBe("POST");
    expect(Object.fromEntries(new Headers(init.headers))).toMatchObject({
      "x-api-key": "gsk_test123",
      "content-type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      text: request.text,
      voice_id: "YTpq7expH9539ERJ",
      only_audio: true,
      json_config: '{"padding_bonus":0}',
      ...overrides,
    });
  };
  const isConfigured = (providerConfig: SpeechSynthesisRequest["providerConfig"]) =>
    provider.isConfiguredAsync?.({ providerConfig, timeoutMs: 5_000 });

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
      expectRequest({ output_format: format });
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
    expectRequest({
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

  it("includes parsed provider detail and request id for JSON API errors", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { message: "Invalid API key" },
        { status: 401, headers: { "x-request-id": "grad_req_123" } },
      ),
    );
    await expect(provider.synthesize(request)).rejects.toThrow(
      "Gradium API error (401): Invalid API key [request_id=grad_req_123]",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("redacts the active credential from provider diagnostics", async () => {
    const credential = "opaque-gradium-secret42";
    fetchMock.mockResolvedValue(
      Response.json({ message: `provider diagnostic ${credential}` }, { status: 401 }),
    );
    const error: unknown = await provider
      .synthesize({ ...request, providerConfig: { ...request.providerConfig, apiKey: credential } })
      .catch((cause: unknown) => cause);
    assert(error instanceof Error);
    expect(formatErrorMessage(error)).not.toContain(credential);
    expect(error.message).toContain("provider diagnostic");
    expect(error).toMatchObject({ status: 401, statusCode: 401 });
  });

  it("includes raw non-JSON error detail while capping streamed body reads", async () => {
    const streamed = createStreamingResponse({
      status: 503,
      chunkCount: 200,
      chunkSize: 1024,
      byte: 121,
    });
    fetchMock.mockResolvedValue(streamed.response);
    await expect(provider.synthesize(request)).rejects.toThrow("Gradium API error (503): yyyy");
    expect(streamed.getReadCount()).toBeLessThan(200);
  });

  it.each([
    ["http://api.gradium.ai", "Gradium baseUrl must use https"],
    ["https://api.gradium.ai.example.com", "Gradium baseUrl must target api.gradium.ai"],
  ])("rejects %s before sending the API key", async (baseUrl, expectedError) => {
    await expect(
      provider.synthesize({ ...request, providerConfig: { ...request.providerConfig, baseUrl } }),
    ).rejects.toThrow(expectedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["application/json", '{"error":"denied"}'],
    ["audio/mpeg", ""],
  ])("rejects malformed %s success responses", async (contentType, body) => {
    fetchMock.mockResolvedValue(
      new Response(body, { status: 200, headers: { "content-type": contentType } }),
    );
    await expect(provider.synthesize(request)).rejects.toThrow(
      "Gradium API error: malformed audio response",
    );
  });
});

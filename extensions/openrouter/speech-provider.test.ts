import { requireFirstPostJsonRecordRequest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenRouterSpeechProvider } from "./speech-provider.js";

const { assertOkOrThrowHttpErrorMock, postJsonRequestMock } = vi.hoisted(() => ({
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  postJsonRequestMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  postJsonRequest: postJsonRequestMock,
}));

function requireHeaders(value: unknown): Headers {
  if (!(value instanceof Headers)) {
    throw new Error("expected OpenRouter speech request headers");
  }
  return value;
}

function synthesize(
  modelProvider: { apiKey?: string; baseUrl: string },
  providerConfig: { baseUrl?: string } = {},
) {
  return buildOpenRouterSpeechProvider().synthesize({
    text: "private proxy speech",
    cfg: { models: { providers: { openrouter: modelProvider } } } as never,
    providerConfig,
    target: "voice-note",
    timeoutMs: 5000,
  });
}

function mockAudioResponse() {
  postJsonRequestMock.mockResolvedValue({
    response: new Response(new Uint8Array([1]), { status: 200 }),
    release: vi.fn(async () => {}),
  });
}

function expectDestination(url: string) {
  const request = requireFirstPostJsonRecordRequest(
    postJsonRequestMock,
    "OpenRouter speech request",
  );
  expect(request.url).toBe(url);
  expect(requireHeaders(request.headers).get("authorization")).toBe(
    "Bearer synthetic-private-proxy-key",
  );
}

describe("openrouter speech provider", () => {
  afterEach(() => {
    assertOkOrThrowHttpErrorMock.mockClear();
    postJsonRequestMock.mockReset();
    vi.unstubAllEnvs();
  });

  it("advertises the documented ElevenLabs route", () => {
    expect(buildOpenRouterSpeechProvider().models).toContain("elevenlabs/eleven-turbo-v2");
  });

  it("normalizes provider-owned speech config", () => {
    const provider = buildOpenRouterSpeechProvider();
    const extra = { options: { openai: { instructions: "Speak warmly." } } };
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      timeoutMs: 30_000,
      rawConfig: {
        providers: {
          openrouter: {
            apiKey: "sk-test",
            baseUrl: "https://openrouter.ai/v1/",
            modelId: "google/gemini-3.1-flash-tts-preview",
            voiceId: "Kore",
            speed: 1.1,
            responseFormat: " MP3 ",
            provider: extra,
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "sk-test",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "google/gemini-3.1-flash-tts-preview",
      voice: "Kore",
      speed: 1.1,
      responseFormat: "mp3",
      provider: extra,
    });
  });

  it("never sends a custom model-provider credential to the public speech endpoint", async () => {
    mockAudioResponse();
    const result = await synthesize({
      apiKey: "synthetic-private-proxy-key",
      baseUrl: "https://private.example.invalid/router/v1///",
    });

    expectDestination("https://private.example.invalid/router/v1/audio/speech");
    expect(
      requireFirstPostJsonRecordRequest(postJsonRequestMock, "speech request").body,
    ).toMatchObject({
      model: "hexgrad/kokoro-82m",
      input: "private proxy speech",
      voice: "af_alloy",
      response_format: "mp3",
    });
    expect(result.audioBuffer).toEqual(Buffer.from([1]));
  });

  it("preserves a speech-specific custom destination over the model-provider base URL", async () => {
    mockAudioResponse();
    await synthesize(
      {
        apiKey: "synthetic-private-proxy-key",
        baseUrl: "https://model-proxy.example.invalid/v1",
      },
      { baseUrl: "https://speech-proxy.example.invalid/router/v1///" },
    );

    expectDestination("https://speech-proxy.example.invalid/router/v1/audio/speech");
  });

  it("does not synthesize when a configured private destination has no credential", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");

    await expect(synthesize({ baseUrl: "https://private.example.invalid/v1" })).rejects.toThrow(
      "OpenRouter API key missing",
    );
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("defaults to a live-proven OpenRouter TTS model", () => {
    const provider = buildOpenRouterSpeechProvider();
    expect(provider.defaultTimeoutMs).toBe(120_000);

    expect(
      provider.resolveConfig?.({ cfg: {} as never, rawConfig: {}, timeoutMs: 30_000 }),
    ).toEqual({
      model: "hexgrad/kokoro-82m",
      voice: "af_alloy",
      responseFormat: undefined,
      provider: undefined,
    });
  });

  it("uses OPENROUTER_API_KEY when provider config omits apiKey", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-env");
    const provider = buildOpenRouterSpeechProvider();

    expect(provider.isConfigured({ cfg: {} as never, providerConfig: {}, timeoutMs: 30_000 })).toBe(
      true,
    );
  });
});

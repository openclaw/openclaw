import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenrouterSpeechProvider } from "./speech-provider.js";

const {
  fetchWithTimeoutMock,
  assertOkOrThrowHttpErrorMock,
  resolveProviderHttpRequestConfigMock,
} = vi.hoisted(() => ({
  fetchWithTimeoutMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  resolveProviderHttpRequestConfigMock: vi.fn((params) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: Boolean(params.allowPrivateNetwork),
    headers: new Headers(params.defaultHeaders),
    dispatcherPolicy: undefined,
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  fetchWithTimeout: fetchWithTimeoutMock,
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
}));

function makeSseStream(chunks: Array<{ data?: string; transcript?: string }>): ReadableStream {
  const lines: string[] = [];
  for (const chunk of chunks) {
    const delta: Record<string, unknown> = {};
    if (chunk.data != null || chunk.transcript != null) {
      const audio: Record<string, string> = {};
      if (chunk.data != null) {
        audio.data = chunk.data;
      }
      if (chunk.transcript != null) {
        audio.transcript = chunk.transcript;
      }
      delta.audio = audio;
    }
    lines.push(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
  }
  lines.push("data: [DONE]\n\n");

  const encoder = new TextEncoder();
  const text = lines.join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function mockSseResponse(chunks: Array<{ data?: string; transcript?: string }>) {
  fetchWithTimeoutMock.mockResolvedValue(
    new Response(makeSseStream(chunks), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  );
}

function parseRequestBody(): Record<string, unknown> {
  const body = fetchWithTimeoutMock.mock.calls[0]?.[1]?.body as string;
  return JSON.parse(body) as Record<string, unknown>;
}

describe("openrouter speech provider", () => {
  afterEach(() => {
    fetchWithTimeoutMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
    vi.unstubAllEnvs();
  });

  it("exposes correct provider metadata", () => {
    const provider = buildOpenrouterSpeechProvider();
    expect(provider.id).toBe("openrouter");
    expect(provider.label).toBe("OpenRouter");
    expect(provider.models).toContain("openai/gpt-audio");
    expect(provider.models).toContain("openai/gpt-audio-mini");
    expect(provider.models).toContain("openai/gpt-4o-audio-preview");
    expect(provider.voices).toContain("alloy");
    expect(provider.voices).toContain("nova");
    expect(provider.voices).toContain("shimmer");
  });

  it("synthesizes speech with default model and voice", async () => {
    const audioBase64 = Buffer.from("speech-bytes").toString("base64");
    mockSseResponse([{ data: audioBase64, transcript: "Hello" }]);

    const provider = buildOpenrouterSpeechProvider();
    const result = await provider.synthesize({
      text: "Say hello",
      cfg: {},
      providerConfig: { apiKey: "test-key" },
      target: "audio-file",
      timeoutMs: 30_000,
    });

    expect(result.audioBuffer).toEqual(Buffer.from(audioBase64, "base64"));
    expect(result.outputFormat).toBe("audio/mpeg");
    expect(result.fileExtension).toBe(".mp3");
    expect(result.voiceCompatible).toBe(false);

    const body = parseRequestBody();
    expect(body.model).toBe("openai/gpt-audio-mini");
    expect(body.modalities).toEqual(["text", "audio"]);
    expect(body.stream).toBe(true);
    const audio = body.audio as { voice: string; format: string };
    expect(audio.voice).toBe("alloy");
    expect(audio.format).toBe("mp3");
  });

  it("uses opus format for voice-note target", async () => {
    mockSseResponse([{ data: Buffer.from("opus-bytes").toString("base64") }]);

    const provider = buildOpenrouterSpeechProvider();
    const result = await provider.synthesize({
      text: "Voice note",
      cfg: {},
      providerConfig: { apiKey: "test-key" },
      target: "voice-note",
      timeoutMs: 30_000,
    });

    expect(result.outputFormat).toBe("audio/ogg");
    expect(result.fileExtension).toBe(".opus");
    expect(result.voiceCompatible).toBe(true);

    const body = parseRequestBody();
    const audio = body.audio as { format: string };
    expect(audio.format).toBe("opus");
  });

  it("honors providerConfig model, voice, and format overrides", async () => {
    mockSseResponse([{ data: Buffer.from("wav-data").toString("base64") }]);

    const provider = buildOpenrouterSpeechProvider();
    await provider.synthesize({
      text: "Custom config",
      cfg: {},
      providerConfig: {
        apiKey: "test-key",
        model: "openai/gpt-4o-audio-preview",
        voice: "nova",
        format: "wav",
      },
      target: "audio-file",
      timeoutMs: 30_000,
    });

    const body = parseRequestBody();
    expect(body.model).toBe("openai/gpt-4o-audio-preview");
    const audio = body.audio as { voice: string; format: string };
    expect(audio.voice).toBe("nova");
    expect(audio.format).toBe("wav");
  });

  it("applies providerOverrides for model and voice at runtime", async () => {
    mockSseResponse([{ data: Buffer.from("bytes").toString("base64") }]);

    const provider = buildOpenrouterSpeechProvider();
    await provider.synthesize({
      text: "Override test",
      cfg: {},
      providerConfig: {
        apiKey: "test-key",
        model: "openai/gpt-audio-mini",
        voice: "alloy",
      },
      providerOverrides: {
        model: "openai/gpt-audio",
        voice: "shimmer",
      },
      target: "audio-file",
      timeoutMs: 30_000,
    });

    const body = parseRequestBody();
    expect(body.model).toBe("openai/gpt-audio");
    const audio = body.audio as { voice: string };
    expect(audio.voice).toBe("shimmer");
  });

  it("detects configuration from providerConfig apiKey", () => {
    const provider = buildOpenrouterSpeechProvider();
    expect(
      provider.isConfigured({ providerConfig: { apiKey: "key" }, cfg: {}, timeoutMs: 0 }),
    ).toBe(true);
    expect(provider.isConfigured({ providerConfig: {}, cfg: {}, timeoutMs: 0 })).toBe(false);
  });

  it("detects configuration from OPENROUTER_API_KEY env", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "env-key");
    const provider = buildOpenrouterSpeechProvider();
    expect(provider.isConfigured({ providerConfig: {}, cfg: {}, timeoutMs: 0 })).toBe(true);
  });

  it("throws when response contains no audio data", async () => {
    mockSseResponse([]);

    const provider = buildOpenrouterSpeechProvider();
    await expect(
      provider.synthesize({
        text: "empty",
        cfg: {},
        providerConfig: { apiKey: "test-key" },
        target: "audio-file",
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow("OpenRouter speech synthesis response missing audio data");
  });

  it("throws when API key is missing", async () => {
    const provider = buildOpenrouterSpeechProvider();
    await expect(
      provider.synthesize({
        text: "test",
        cfg: {},
        providerConfig: {},
        target: "audio-file",
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow("OpenRouter API key missing for speech synthesis");
  });

  it("lists available voices", async () => {
    const provider = buildOpenrouterSpeechProvider();
    const voices = await provider.listVoices!({});
    expect(voices).toHaveLength(6);
    expect(voices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "alloy" }),
        expect.objectContaining({ id: "echo" }),
        expect.objectContaining({ id: "fable" }),
        expect.objectContaining({ id: "onyx" }),
        expect.objectContaining({ id: "nova" }),
        expect.objectContaining({ id: "shimmer" }),
      ]),
    );
  });

  it("normalizes raw provider config via resolveConfig", () => {
    const provider = buildOpenrouterSpeechProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      timeoutMs: 30_000,
      rawConfig: {
        providers: {
          openrouter: {
            apiKey: "or-key",
            model: "openai/gpt-audio",
            voice: "nova",
            format: "wav",
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "or-key",
      model: "openai/gpt-audio",
      voice: "nova",
      format: "wav",
    });
  });

  it("resolveConfig returns empty config for missing provider section", () => {
    const provider = buildOpenrouterSpeechProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      timeoutMs: 30_000,
      rawConfig: {},
    });

    expect(resolved).toEqual({});
  });

  it("parses voice directive token", () => {
    const provider = buildOpenrouterSpeechProvider();
    expect(
      provider.parseDirectiveToken?.({
        key: "voice",
        value: "nova",
        policy: { allowVoice: true, allowModelId: true },
      } as never),
    ).toEqual({ handled: true, overrides: { voice: "nova" } });
  });

  it("rejects invalid voice in directive token", () => {
    const provider = buildOpenrouterSpeechProvider();
    const result = provider.parseDirectiveToken?.({
      key: "voice",
      value: "invalid-voice",
      policy: { allowVoice: true },
    } as never);

    expect(result).toMatchObject({ handled: true });
    expect(result?.warnings).toContain('invalid OpenRouter voice "invalid-voice"');
  });

  it("parses model directive token", () => {
    const provider = buildOpenrouterSpeechProvider();
    expect(
      provider.parseDirectiveToken?.({
        key: "model",
        value: "openai/gpt-audio",
        policy: { allowModelId: true },
      } as never),
    ).toEqual({ handled: true, overrides: { model: "openai/gpt-audio" } });
  });

  it("does not handle unknown model in directive token", () => {
    const provider = buildOpenrouterSpeechProvider();
    expect(
      provider.parseDirectiveToken?.({
        key: "model",
        value: "unknown/model",
        policy: { allowModelId: true },
      } as never),
    ).toEqual({ handled: false });
  });

  it("ignores voice directive when policy disallows it", () => {
    const provider = buildOpenrouterSpeechProvider();
    expect(
      provider.parseDirectiveToken?.({
        key: "voice",
        value: "nova",
        policy: { allowVoice: false },
      } as never),
    ).toEqual({ handled: true });
  });
});

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
  });

  it("synthesizes speech from a streaming audio response", async () => {
    const audioBase64 = Buffer.from("speech-bytes").toString("base64");

    fetchWithTimeoutMock.mockResolvedValue(
      new Response(
        makeSseStream([{ data: audioBase64, transcript: "Hello" }]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

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

    const callBody = JSON.parse(
      fetchWithTimeoutMock.mock.calls[0]?.[1]?.body as string,
    ) as Record<string, unknown>;
    expect(callBody.model).toBe("openai/gpt-audio-mini");
    expect(callBody.modalities).toEqual(["text", "audio"]);
    expect(callBody.stream).toBe(true);
    const audio = callBody.audio as { voice: string; format: string };
    expect(audio.voice).toBe("alloy");
    expect(audio.format).toBe("mp3");
  });

  it("uses opus format for voice-note target", async () => {
    const audioBase64 = Buffer.from("opus-bytes").toString("base64");

    fetchWithTimeoutMock.mockResolvedValue(
      new Response(
        makeSseStream([{ data: audioBase64 }]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

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
  });

  it("detects configuration from providerConfig apiKey", () => {
    const provider = buildOpenrouterSpeechProvider();
    expect(provider.isConfigured({ providerConfig: { apiKey: "key" }, cfg: {}, timeoutMs: 0 })).toBe(
      true,
    );
    expect(provider.isConfigured({ providerConfig: {}, cfg: {}, timeoutMs: 0 })).toBe(false);
  });

  it("detects configuration from OPENROUTER_API_KEY env", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "env-key");
    const provider = buildOpenrouterSpeechProvider();
    expect(provider.isConfigured({ providerConfig: {}, cfg: {}, timeoutMs: 0 })).toBe(true);
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
    expect(voices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "alloy" }),
        expect.objectContaining({ id: "nova" }),
        expect.objectContaining({ id: "shimmer" }),
      ]),
    );
  });
});

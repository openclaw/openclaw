// Elevenlabs tests cover speech provider plugin behavior.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { isValidElevenLabsVoiceId } from "./shared.js";
import { buildElevenLabsSpeechProvider } from "./speech-provider.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: async ({
    url,
    init,
  }: {
    url: string;
    init?: RequestInit;
  }): Promise<{ response: Response; release: () => Promise<void> }> => ({
    response: await globalThis.fetch(url, init),
    release: vi.fn(async () => {}),
  }),
  ssrfPolicyFromHttpBaseUrlAllowedHostname: () => undefined,
}));

function parseRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("expected string request body");
  }
  const body: unknown = JSON.parse(init.body);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("expected ElevenLabs request body");
  }
  return body as Record<string, unknown>;
}

/** Successful `/with-timestamps` JSON payload — telephony synthesis hits that endpoint first. */
function withTimestampsResponse(options?: {
  audio?: Uint8Array;
  alignment?: { characters: string[]; character_start_times_seconds: number[] };
}): Response {
  return new Response(
    JSON.stringify({
      audio_base64: Buffer.from(options?.audio ?? new Uint8Array([1, 2, 3])).toString("base64"),
      ...(options?.alignment ? { alignment: options.alignment } : {}),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("elevenlabs speech provider", () => {
  const originalFetch = globalThis.fetch;

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("exposes the current ElevenLabs TTS model catalog", () => {
    const provider = buildElevenLabsSpeechProvider();

    expect(provider.models).toEqual([
      "eleven_v3",
      "eleven_multilingual_v2",
      "eleven_flash_v2_5",
      "eleven_flash_v2",
      "eleven_turbo_v2_5",
      "eleven_monolingual_v1",
    ]);
  });

  it("keeps non-equivalent deprecated ElevenLabs TTS model IDs", async () => {
    const provider = buildElevenLabsSpeechProvider();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = parseRequestBody(init);
      expect(body.model_id).toBe("eleven_monolingual_v1");
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await provider.synthesizeTelephony?.({
      text: "hello",
      cfg: {} as never,
      providerConfig: {
        apiKey: "xi-test",
        modelId: "eleven_monolingual_v1",
      },
      timeoutMs: 1_000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps deprecated ElevenLabs TTS model IDs in overrides", async () => {
    const provider = buildElevenLabsSpeechProvider();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = parseRequestBody(init);
      expect(body.model_id).toBe("eleven_flash_v2_5");
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await provider.synthesizeTelephony?.({
      text: "hello",
      cfg: {} as never,
      providerConfig: {
        apiKey: "xi-test",
        modelId: "eleven_multilingual_v2",
      },
      providerOverrides: {
        modelId: "eleven_turbo_v2_5",
      },
      timeoutMs: 1_000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("validates ElevenLabs voice ID length and character rules", () => {
    const cases = [
      { value: "pMsXgVXv3BLzUgSXRplE", expected: true },
      { value: "21m00Tcm4TlvDq8ikWAM", expected: true },
      { value: "VoiceAlias1234567890", expected: true },
      { value: "a1b2c3d4e5", expected: true },
      { value: "a".repeat(40), expected: true },
      { value: "", expected: false },
      { value: "abc", expected: false },
      { value: "123456789", expected: false },
      { value: "a".repeat(41), expected: false },
      { value: "a".repeat(100), expected: false },
      { value: "pMsXgVXv3BLz-gSXRplE", expected: false },
      { value: "pMsXgVXv3BLz_gSXRplE", expected: false },
      { value: "pMsXgVXv3BLz gSXRplE", expected: false },
      { value: "../../../etc/passwd", expected: false },
      { value: "voice?param=value", expected: false },
    ] as const;
    for (const testCase of cases) {
      expect(isValidElevenLabsVoiceId(testCase.value), testCase.value).toBe(testCase.expected);
    }
  });

  it("applies provider overrides to telephony synthesis", async () => {
    const provider = buildElevenLabsSpeechProvider();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/with-timestamps");
      expect(url).toContain("output_format=pcm_22050");
      const body = parseRequestBody(init);
      expect(body).toEqual({
        text: "hello",
        model_id: "eleven_v3",
        seed: 123,
        apply_text_normalization: "on",
        language_code: "en",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0,
          use_speaker_boost: true,
          speed: 1.2,
        },
      });
      return withTimestampsResponse();
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await provider.synthesizeTelephony?.({
      text: "hello",
      cfg: {} as never,
      providerConfig: {
        apiKey: "xi-test",
        voiceId: "pMsXgVXv3BLzUgSXRplE",
        modelId: "eleven_multilingual_v2",
      },
      providerOverrides: {
        voiceId: "21m00Tcm4TlvDq8ikWAM",
        modelId: "eleven_v3",
        seed: 123,
        applyTextNormalization: "on",
        languageCode: "en",
        voiceSettings: {
          speed: 1.2,
        },
      },
      withTimestamps: true,
      timeoutMs: 1_000,
    });

    expect(result?.outputFormat).toBe("pcm_22050");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces character alignment from telephony synthesis", async () => {
    const provider = buildElevenLabsSpeechProvider();
    const fetchMock = vi.fn(async () =>
      withTimestampsResponse({
        alignment: { characters: ["h", "i"], character_start_times_seconds: [0, 0.4] },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await provider.synthesizeTelephony?.({
      text: "hi",
      cfg: {} as never,
      providerConfig: { apiKey: "xi-test" },
      withTimestamps: true,
      timeoutMs: 1_000,
    });

    expect(result?.alignment).toEqual({ characters: ["h", "i"], startTimesSeconds: [0, 0.4] });
    expect(result?.sampleRate).toBe(22_050);
  });

  it("falls back to plain telephony synthesis when with-timestamps fails", async () => {
    const provider = buildElevenLabsSpeechProvider();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/with-timestamps")) {
        return new Response("not found", { status: 404 });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await provider.synthesizeTelephony?.({
      text: "hi",
      cfg: {} as never,
      providerConfig: { apiKey: "xi-test" },
      withTimestamps: true,
      timeoutMs: 1_000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result?.audioBuffer.equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(result?.alignment).toBeUndefined();
  });

  it("drops out-of-range voice settings before synthesis", async () => {
    const provider = buildElevenLabsSpeechProvider();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = parseRequestBody(init);
      expect(body.voice_settings).toEqual({
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0,
        use_speaker_boost: true,
        speed: 1,
      });
      return withTimestampsResponse();
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await provider.synthesizeTelephony?.({
      text: "hello",
      cfg: {} as never,
      providerConfig: {
        apiKey: "xi-test",
        voiceSettings: {
          stability: -1,
          similarityBoost: 2,
          style: Number.NaN,
          speed: 3,
        },
      },
      providerOverrides: {
        voiceSettings: {
          speed: 0.1,
        },
      },
      withTimestamps: true,
      timeoutMs: 1_000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops malformed seed values before synthesis", async () => {
    const provider = buildElevenLabsSpeechProvider();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = parseRequestBody(init);
      expect(body).not.toHaveProperty("seed");
      return withTimestampsResponse();
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await provider.synthesizeTelephony?.({
      text: "hello",
      cfg: {} as never,
      providerConfig: {
        apiKey: "xi-test",
        seed: 1.5,
      },
      providerOverrides: {
        seed: Number.POSITIVE_INFINITY,
      },
      withTimestamps: true,
      timeoutMs: 1_000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops malformed latency tier overrides before synthesis", async () => {
    const provider = buildElevenLabsSpeechProvider();
    const fetchMock = vi.fn(async (url: string) => {
      expect(new URL(url).searchParams.has("optimize_streaming_latency")).toBe(false);
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await provider.synthesize?.({
      text: "hello",
      target: "audio-file",
      cfg: {} as never,
      providerConfig: {
        apiKey: "xi-test",
      },
      providerOverrides: {
        latencyTier: 2.5,
      },
      timeoutMs: 1_000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

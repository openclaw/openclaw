import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElevenLabsVoiceId } from "./shared.js";
import { buildElevenLabsSpeechProvider } from "./speech-provider-factory.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("./config-api.js", () => ({
  resolveElevenLabsApiKeyWithProfileFallback: () => null,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: async (params: {
    url: string;
    init?: RequestInit;
    timeoutMs?: number;
  }): Promise<{ response: Response; release: () => Promise<void> }> => {
    fetchWithSsrFGuardMock(params);
    return {
      response: await globalThis.fetch(params.url, params.init),
      release: vi.fn(async () => {}),
    };
  },
  ssrfPolicyFromHttpBaseUrlAllowedHostname: () => undefined,
}));

const DIRECTIVE_POLICY = {
  enabled: true,
  allowText: true,
  allowProvider: true,
  allowVoice: true,
  allowModelId: true,
  allowVoiceSettings: true,
  allowNormalization: true,
  allowSeed: true,
};

const request = {
  text: "hello",
  cfg: {},
  providerConfig: { apiKey: "xi-test" },
  target: "voice-note" as const,
  timeoutMs: 1_000,
};

describe("elevenlabs speech provider", () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn<typeof fetch>();
  const provider = buildElevenLabsSpeechProvider({ formatErrorMessage });

  function sentRequest() {
    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = expectDefined(fetchMock.mock.calls[0], "ElevenLabs request");
    if (typeof init?.body !== "string") {
      throw new Error("expected string request body");
    }
    const body: unknown = JSON.parse(init.body);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("expected ElevenLabs request body");
    }
    return { url: new URL(resolveRequestUrl(input)), body };
  }

  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    globalThis.fetch = fetchMock;
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fetchWithSsrFGuardMock.mockClear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    ["stability", "0", { stability: 0 }],
    ["similarity_boost", "5e-1", { similarityBoost: 0.5 }],
    ["style", "1", { style: 1 }],
    ["speed", ".5", { speed: 0.5 }],
    ["speed", "2", { speed: 2 }],
    ["stability", "-0.1", "stability must be between 0 and 1"],
    ["similarity", "Infinity", "invalid similarityBoost value"],
    ["similarity_boost", "1.1", "similarityBoost must be between 0 and 1"],
    ["speed", ".49", "speed must be between 0.5 and 2"],
    ["speed", "2.01", "speed must be between 0.5 and 2"],
    ["speed", "invalid", undefined, false],
  ] as const)(
    "preserves the %s=%s voice-setting directive",
    (key, value, expected, allowed?: boolean) => {
      const currentOverrides = { voiceId: "existing-voice", voiceSettings: { style: 0.25 } };
      const allowVoiceSettings = allowed ?? true;
      const parsed = provider.parseDirectiveToken?.({
        key,
        value,
        policy: { ...DIRECTIVE_POLICY, allowVoiceSettings },
        currentOverrides,
      });

      expect(parsed).toEqual(
        !allowVoiceSettings
          ? { handled: true }
          : typeof expected === "string"
            ? { handled: true, warnings: [expected] }
            : {
                handled: true,
                overrides: {
                  ...currentOverrides,
                  voiceSettings: { ...currentOverrides.voiceSettings, ...expected },
                },
              },
      );
    },
  );

  it("forwards the core-resolved voice-list timeout", async () => {
    fetchMock.mockResolvedValue(Response.json({ voices: [] }));
    await provider.listVoices?.({ providerConfig: request.providerConfig, timeoutMs: 30_000 });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });

  it("rejects blank credentials across discovery and synthesis before requests", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "   ");
    vi.stubEnv("XI_API_KEY", "   ");
    const providerConfig = { apiKey: "   " };
    const blankRequest = { ...request, providerConfig };

    expect(provider.isConfigured(blankRequest)).toBe(false);
    await expect(
      provider.listVoices?.({ apiKey: "   ", providerConfig, timeoutMs: 1_000 }),
    ).rejects.toThrow("ElevenLabs API key missing");
    await expect(provider.synthesize(blankRequest)).rejects.toThrow("ElevenLabs API key missing");
    await expect(provider.streamSynthesize?.(blankRequest)).rejects.toThrow(
      "ElevenLabs API key missing",
    );
    await expect(provider.synthesizeTelephony?.(blankRequest)).rejects.toThrow(
      "ElevenLabs API key missing",
    );
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("keeps non-equivalent deprecated ElevenLabs TTS model IDs", async () => {
    await provider.synthesizeTelephony?.({
      ...request,
      providerConfig: { apiKey: "xi-test", modelId: "eleven_monolingual_v1" },
    });
    expect(sentRequest().body).toHaveProperty("model_id", "eleven_monolingual_v1");
  });

  it("maps deprecated ElevenLabs TTS model IDs in overrides", async () => {
    await provider.synthesizeTelephony?.({
      ...request,
      providerConfig: { apiKey: "xi-test", modelId: "eleven_multilingual_v2" },
      providerOverrides: { modelId: "eleven_turbo_v2_5" },
    });
    expect(sentRequest().body).toHaveProperty("model_id", "eleven_flash_v2_5");
  });

  it("validates ElevenLabs voice ID length and character rules", () => {
    const cases = [
      { value: "a1b2c3d4e5", expected: true },
      { value: "a".repeat(40), expected: true },
      { value: "123456789", expected: false },
      { value: "a".repeat(41), expected: false },
      { value: "pMsXgVXv3BLz-gSXRplE", expected: false },
      { value: "../../../etc/passwd", expected: false },
      { value: "voice?param=value", expected: false },
    ] as const;
    for (const testCase of cases) {
      expect(isValidElevenLabsVoiceId(testCase.value), testCase.value).toBe(testCase.expected);
    }
  });

  it("applies provider overrides to telephony synthesis", async () => {
    const result = await provider.synthesizeTelephony?.({
      ...request,
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
        voiceSettings: { speed: 1.2 },
      },
    });
    const { url, body } = sentRequest();
    expect(url.pathname).toBe("/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM");
    expect(url.searchParams.get("output_format")).toBe("pcm_22050");
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
    expect(result?.outputFormat).toBe("pcm_22050");
  });

  it("drops out-of-range voice settings before synthesis", async () => {
    await provider.synthesizeTelephony?.({
      ...request,
      providerConfig: {
        apiKey: "xi-test",
        voiceSettings: { stability: -1, similarityBoost: 2, style: Number.NaN, speed: 3 },
      },
      providerOverrides: { voiceSettings: { speed: 0.1 } },
    });
    expect(sentRequest().body).toHaveProperty("voice_settings", {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0,
      use_speaker_boost: true,
      speed: 1,
    });
  });

  it("drops malformed seed values before synthesis", async () => {
    await provider.synthesizeTelephony?.({
      ...request,
      providerConfig: { apiKey: "xi-test", seed: 1.5 },
      providerOverrides: { seed: Number.POSITIVE_INFINITY },
    });
    expect(sentRequest().body).not.toHaveProperty("seed");
  });

  it("drops malformed latency tier overrides before synthesis", async () => {
    await provider.synthesize({
      ...request,
      target: "audio-file",
      providerOverrides: { latencyTier: 2.5 },
    });
    expect(sentRequest().url.searchParams.has("optimize_streaming_latency")).toBe(false);
  });

  it.each([
    { outputFormat: "pcm_44100", fileExtension: ".pcm", voiceCompatible: false },
    { outputFormat: "OPUS_48000_64", fileExtension: ".opus", voiceCompatible: true },
    { outputFormat: "future_123", fileExtension: ".bin", voiceCompatible: false },
  ])("returns truthful $outputFormat metadata for a voice-note override", async (expected) => {
    const result = await provider.synthesize({
      ...request,
      providerOverrides: { outputFormat: expected.outputFormat },
    });
    expect(sentRequest().url.searchParams.get("output_format")).toBe(expected.outputFormat);
    expect(result).toEqual({ audioBuffer: Buffer.from([1, 2, 3]), ...expected });
  });

  it("returns truthful stream metadata for an output override and releases the stream once", async () => {
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
          },
          cancel,
        }),
        { headers: { "content-type": "audio/mpeg" } },
      ),
    );
    const result = expectDefined(
      await provider.streamSynthesize?.({
        ...request,
        providerOverrides: { outputFormat: "pcm_44100" },
      }),
      "streamSynthesize result",
    );
    expect(sentRequest().url.searchParams.get("output_format")).toBe("pcm_44100");
    expect(result).toMatchObject({
      outputFormat: "pcm_44100",
      fileExtension: ".pcm",
      voiceCompatible: false,
    });
    const release = expectDefined(result.release, "stream release");
    expect(cancel).not.toHaveBeenCalled();
    await release();
    await release();
    expect(cancel).toHaveBeenCalledOnce();
  });
});

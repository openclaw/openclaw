import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { afterAll, afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpeechDirectivePolicy } from "../test-support/speech-directive-policy.test-support.js";
import { isValidElevenLabsVoiceId } from "./shared.js";
import { buildElevenLabsSpeechProvider } from "./speech-provider-factory.js";

const fetchMock = vi.hoisted(() =>
  vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>(),
);

vi.mock("./config-api.js", () => ({
  resolveElevenLabsApiKeyWithProfileFallback: () => null,
}));

// mock-isolation: Synthesis uses fixture-owned transport and never performs external requests.
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchMock,
  ssrfPolicyFromHttpBaseUrlAllowedHostname: () => undefined,
}));

const DIRECTIVE_POLICY = createSpeechDirectivePolicy();

const request = {
  text: "hello",
  cfg: {},
  providerConfig: { apiKey: "xi-test" },
  target: "voice-note" as const,
  timeoutMs: 1_000,
};

describe("elevenlabs speech provider", () => {
  const provider = buildElevenLabsSpeechProvider({ formatErrorMessage });
  function mockResponse(response: Response) {
    fetchMock.mockResolvedValue({
      response,
      finalUrl: "https://api.elevenlabs.io",
      release: async () => {},
    });
  }

  function sentRequest() {
    const [{ url, init }] = expectDefined(fetchMock.mock.calls[0], "ElevenLabs request");
    const raw = init?.body;
    assert(typeof raw === "string", "Expected a JSON request body");
    const body: unknown = JSON.parse(raw);
    return { url: new URL(url), body };
  }

  beforeEach(() => {
    fetchMock.mockReset();
    mockResponse(new Response(new Uint8Array([1, 2, 3])));
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.resetModules();
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["stability", "0", true, { overrides: { voiceSettings: { style: 0.25, stability: 0 } } }],
    ["similarity", "Infinity", true, { warnings: ["invalid similarityBoost value"] }],
    ["speed", "2.01", true, { warnings: ["speed must be between 0.5 and 2"] }],
    ["speed", "invalid", false, {}],
  ] as const)(
    "preserves the %s=%s voice-setting directive",
    (key, value, allowVoiceSettings, expected) => {
      expect(
        provider.parseDirectiveToken?.({
          key,
          value,
          policy: { ...DIRECTIVE_POLICY, allowVoiceSettings },
          currentOverrides: { voiceId: "existing-voice", voiceSettings: { style: 0.25 } },
        }),
      ).toEqual({ handled: true, ...expected });
    },
  );

  it("forwards the core-resolved voice-list timeout", async () => {
    mockResponse(Response.json({ voices: [] }));
    await provider.listVoices?.({ providerConfig: request.providerConfig, timeoutMs: 30_000 });
    expect(fetchMock).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30_000 }));
  });

  it("rejects blank credentials across discovery and synthesis before requests", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "   ");
    vi.stubEnv("XI_API_KEY", "   ");
    const providerConfig = { apiKey: "   " };
    const blankRequest = { ...request, providerConfig };

    expect(await provider.isConfiguredAsync?.(blankRequest)).toBe(false);
    await expect(
      provider.listVoices?.({ apiKey: "   ", providerConfig, timeoutMs: 1_000 }),
    ).rejects.toThrow("ElevenLabs API key missing");
    for (const synthesize of [
      provider.synthesize,
      provider.streamSynthesize,
      provider.synthesizeTelephony,
    ]) {
      await expect(synthesize?.(blankRequest)).rejects.toThrow("ElevenLabs API key missing");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes model and voice-setting overrides before telephony synthesis", async () => {
    await provider.synthesizeTelephony?.({
      ...request,
      providerConfig: {
        apiKey: "xi-test",
        modelId: "eleven_multilingual_v2",
        voiceSettings: { stability: -1, similarityBoost: 2, style: Number.NaN, speed: 3 },
      },
      providerOverrides: { modelId: "eleven_turbo_v2_5", voiceSettings: { speed: 0.1 } },
    });
    const { body } = sentRequest();
    expect(body).toHaveProperty("model_id", "eleven_flash_v2_5");
    expect(body).toHaveProperty("voice_settings", {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0,
      use_speaker_boost: true,
      speed: 1,
    });
  });

  it("validates ElevenLabs voice ID length and character rules", () => {
    for (const [value, expected] of [
      ["a1b2c3d4e5", true],
      ["a".repeat(40), true],
      ["123456789", false],
      ["a".repeat(41), false],
      ["pMsXgVXv3BLz-gSXRplE", false],
      ["../../../etc/passwd", false],
      ["voice?param=value", false],
    ] as const) {
      expect(isValidElevenLabsVoiceId(value), value).toBe(expected);
    }
  });

  it("returns future-format metadata and drops invalid latency for a voice-note override", async () => {
    const expected = { outputFormat: "future_123", fileExtension: ".bin", voiceCompatible: false };
    const result = await provider.synthesize({
      ...request,
      providerOverrides: { outputFormat: expected.outputFormat, latencyTier: 2.5 },
    });
    expect(sentRequest().url.searchParams.get("output_format")).toBe(expected.outputFormat);
    expect(sentRequest().url.searchParams.has("optimize_streaming_latency")).toBe(false);
    expect(result).toEqual({ audioBuffer: Buffer.from([1, 2, 3]), ...expected });
  });

  it("returns truthful stream metadata for an output override and releases the stream once", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    mockResponse(new Response(stream, { headers: { "content-type": "audio/mpeg" } }));
    const result = await expectDefined(
      provider.streamSynthesize,
      "streamSynthesize",
    )({
      ...request,
      providerOverrides: { outputFormat: "pcm_44100" },
    });
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

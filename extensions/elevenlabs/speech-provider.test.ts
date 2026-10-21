import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import type { SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { isValidElevenLabsVoiceId } from "./shared.js";
import { buildElevenLabsSpeechProvider } from "./speech-provider-factory.js";

const guardMock = vi.hoisted(() => vi.fn());

vi.mock("./config-api.js", () => ({
  resolveElevenLabsApiKeyWithProfileFallback: () => null,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: async (params: { url: string; init?: RequestInit; timeoutMs?: number }) => {
    guardMock(params);
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

const fetchMock = vi.fn<typeof fetch>();
const provider = buildElevenLabsSpeechProvider({ formatErrorMessage });
const withOverrides = (providerOverrides: SpeechSynthesisRequest["providerOverrides"]) => ({
  ...request,
  providerOverrides,
});

function sentRequest() {
  expect(fetchMock).toHaveBeenCalledOnce();
  const [input, init] = expectDefined(fetchMock.mock.calls[0], "ElevenLabs request");
  if (typeof init?.body !== "string") {
    throw new Error("expected string request body");
  }
  const body: unknown = JSON.parse(init.body);
  expect(body && typeof body === "object" && !Array.isArray(body)).toBe(true);
  return { url: new URL(resolveRequestUrl(input)), body };
}

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
  vi.stubGlobal("fetch", fetchMock);
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  guardMock.mockClear();
  vi.unstubAllEnvs();
});

it.each([
  ["stability", "0", { overrides: { voiceSettings: { style: 0.25, stability: 0 } } }, true],
  ["similarity", "Infinity", { warnings: ["invalid similarityBoost value"] }, true],
  ["speed", "2.01", { warnings: ["speed must be between 0.5 and 2"] }, true],
  ["speed", "invalid", {}, false],
] as const)("preserves the %s=%s voice-setting directive", (key, value, expected, allowed) => {
  expect(
    provider.parseDirectiveToken?.({
      key,
      value,
      policy: { ...DIRECTIVE_POLICY, allowVoiceSettings: allowed },
      currentOverrides: { voiceId: "existing-voice", voiceSettings: { style: 0.25 } },
    }),
  ).toEqual({ handled: true, ...expected });
});

it("forwards the core-resolved voice-list timeout", async () => {
  fetchMock.mockResolvedValue(Response.json({ voices: [] }));
  await provider.listVoices?.({ providerConfig: request.providerConfig, timeoutMs: 30_000 });
  expect(guardMock).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30_000 }));
});

it("rejects blank credentials across discovery and synthesis before requests", async () => {
  vi.stubEnv("ELEVENLABS_API_KEY", "   ");
  vi.stubEnv("XI_API_KEY", "   ");
  const blankRequest = { ...request, providerConfig: { apiKey: "   " } };
  const rejectsMissingKey = (result: Promise<unknown> | undefined) =>
    expect(result).rejects.toThrow("ElevenLabs API key missing");

  expect(await provider.isConfiguredAsync?.(blankRequest)).toBe(false);
  await rejectsMissingKey(provider.listVoices?.({ ...blankRequest, apiKey: "   " }));
  await rejectsMissingKey(provider.synthesize(blankRequest));
  await rejectsMissingKey(provider.streamSynthesize?.(blankRequest));
  await rejectsMissingKey(provider.synthesizeTelephony?.(blankRequest));
  expect(guardMock).not.toHaveBeenCalled();
});

it("maps deprecated ElevenLabs TTS model IDs in overrides", async () => {
  await provider.synthesizeTelephony?.(withOverrides({ modelId: "eleven_turbo_v2_5" }));
  expect(sentRequest().body).toHaveProperty("model_id", "eleven_flash_v2_5");
});

it("validates ElevenLabs voice ID length and character rules", () => {
  for (const [values, expected] of [
    [["a1b2c3d4e5", "a".repeat(40)], true],
    [["123456789", "a".repeat(41)], false],
    [["pMsXgVXv3BLz-gSXRplE", "../../../etc/passwd", "voice?param=value"], false],
  ] as const) {
    for (const value of values) {
      expect(isValidElevenLabsVoiceId(value), value).toBe(expected);
    }
  }
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

it("drops malformed latency tier overrides before synthesis", async () => {
  await provider.synthesize({ ...withOverrides({ latencyTier: 2.5 }), target: "audio-file" });
  expect(sentRequest().url.searchParams.has("optimize_streaming_latency")).toBe(false);
});

it("returns truthful future_123 metadata for a voice-note override", async () => {
  const expected = { outputFormat: "future_123", fileExtension: ".bin", voiceCompatible: false };
  const result = await provider.synthesize(withOverrides({ outputFormat: expected.outputFormat }));
  expect(sentRequest().url.searchParams.get("output_format")).toBe(expected.outputFormat);
  expect(result).toEqual({ audioBuffer: Buffer.from([1, 2, 3]), ...expected });
});

it("returns truthful stream metadata for an output override and releases the stream once", async () => {
  const cancel = vi.fn();
  const outputFormat = "pcm_44100";
  const audio = new ReadableStream<Uint8Array>({
    start: (controller) => controller.enqueue(new Uint8Array([1, 2, 3])),
    cancel,
  });
  fetchMock.mockResolvedValue(new Response(audio, { headers: { "content-type": "audio/mpeg" } }));
  const streamSynthesize = expectDefined(provider.streamSynthesize, "streamSynthesize");
  const result = await streamSynthesize(withOverrides({ outputFormat }));
  expect(sentRequest().url.searchParams.get("output_format")).toBe(outputFormat);
  expect(result).toMatchObject({ outputFormat, fileExtension: ".pcm", voiceCompatible: false });
  const release = expectDefined(result.release, "stream release");
  expect(cancel).not.toHaveBeenCalled();
  await release();
  await release();
  expect(cancel).toHaveBeenCalledOnce();
});

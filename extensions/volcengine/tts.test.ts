import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpeechDirectivePolicy } from "../test-support/speech-directive-policy.test-support.js";
import { createClosedChunkStream } from "../test-support/streaming-error-response.js";
import { buildVolcengineSpeechProvider } from "./speech-provider.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

function mockResponse(
  response = Response.json({ code: 0, data: Buffer.from("voice-audio").toString("base64") }),
) {
  const release = vi.fn();
  fetchWithSsrFGuardMock.mockResolvedValue({ response, release });
  return release;
}

const directivePolicy = createSpeechDirectivePolicy();
const provider = buildVolcengineSpeechProvider();
const isConfigured = (providerConfig: Record<string, unknown> = {}) =>
  provider.isConfiguredAsync?.({ providerConfig, timeoutMs: 30000 });

const TTS_ENV_KEYS = [
  "BYTEPLUS_SEED_SPEECH_API_KEY",
  "VOLCENGINE_TTS_API_KEY",
  "VOLCENGINE_TTS_APPID",
  "VOLCENGINE_TTS_TOKEN",
] as const;

beforeEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  for (const key of TTS_ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
});

afterEach(() => vi.unstubAllEnvs());

function synthesize(
  providerConfig: Record<string, unknown> = { apiKey: "test-api-key" },
  overrides: Partial<Parameters<typeof provider.synthesize>[0]> = {},
) {
  return provider.synthesize({
    text: "hello",
    cfg: {},
    providerConfig,
    target: "audio-file",
    timeoutMs: 1000,
    ...overrides,
  });
}

describe("Volcengine speech provider", () => {
  it("reports configured for legacy appId and token in providerConfig", async () => {
    expect(await isConfigured({ appId: "test-app-id", token: "test-token" })).toBe(true);
  });

  it("falls back to env vars for credentials", async () => {
    vi.stubEnv("BYTEPLUS_SEED_SPEECH_API_KEY", "env-api-key");
    expect(await isConfigured()).toBe(true);
  });

  it("rejects blank Seed and legacy credentials before requests", async () => {
    for (const key of TTS_ENV_KEYS) {
      vi.stubEnv(key, "   ");
    }
    const providerConfig = { apiKey: "   ", appId: "   ", token: "   " };

    expect(await isConfigured(providerConfig)).toBe(false);
    await expect(synthesize(providerConfig)).rejects.toThrow("Volcengine TTS credentials missing");

    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("lists voices with locale and gender", async () => {
    const voices = await provider.listVoices?.({});
    expect(voices?.[0]).toEqual({
      id: "en_female_anna_mars_bigtts",
      name: "anna",
      locale: "en-US",
      gender: "female",
    });
  });

  it("sends the documented Seed Speech API key payload and returns voice-note Opus metadata", async () => {
    const release = mockResponse();

    const result = await synthesize(
      { apiKey: "test-api-key", emotion: "happy", speedRatio: 1.2 },
      {
        target: "voice-note",
        providerOverrides: { voice: "zh_male_aojiao_mars_bigtts", speedRatio: 0.9 },
        timeoutMs: 1234,
      },
    );

    expect(result).toEqual({
      audioBuffer: Buffer.from("voice-audio"),
      outputFormat: "opus",
      fileExtension: ".opus",
      voiceCompatible: true,
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
      url: "https://voice.ap-southeast-1.bytepluses.com/api/v3/tts/unidirectional",
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Connection: "keep-alive",
          "X-Api-Key": "test-api-key",
          "X-Api-Resource-Id": "seed-tts-1.0",
          "X-Api-App-Key": "aGjiRDfUWi",
        },
        body: JSON.stringify({
          user: { uid: "openclaw" },
          req_params: {
            text: "hello",
            speaker: "zh_male_aojiao_mars_bigtts",
            audio_params: { format: "ogg_opus", sample_rate: 24000 },
            speed_ratio: 0.9,
            emotion: "happy",
          },
        }),
      },
      timeoutMs: 1234,
      policy: { hostnameAllowlist: ["voice.ap-southeast-1.bytepluses.com"] },
      auditContext: "volcengine.tts",
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("drops malformed speed ratios before synthesis", async () => {
    mockResponse();

    await synthesize(
      { apiKey: "test-api-key", speedRatio: 4 },
      {
        providerOverrides: { speedRatio: -1 },
      },
    );

    const body: { req_params?: { speed_ratio?: number } } = JSON.parse(
      fetchWithSsrFGuardMock.mock.calls[0]![0].init.body,
    );
    expect(body.req_params).not.toHaveProperty("speed_ratio");
  });

  it("joins streamed Seed Speech audio frames", async () => {
    const release = mockResponse(
      new Response(
        [
          JSON.stringify({ code: 0, message: "" }),
          JSON.stringify({ code: 0, data: Buffer.from("audio-1").toString("base64") }),
          JSON.stringify({ code: 0, data: Buffer.from("audio-2").toString("base64") }),
          JSON.stringify({ code: 20000000, message: "ok", data: null }),
        ].join("\n"),
      ),
    );

    const { audioBuffer } = await synthesize();

    expect(audioBuffer.toString()).toBe("audio-1audio-2");
    expect(release).toHaveBeenCalledTimes(1);
  });

  describe.each([
    {
      name: "BytePlus Seed Speech",
      code: 0,
      params: { apiKey: "secret-api-key" },
      secret: "secret-api-key",
      failure: { header: { code: 45000000, message: "speaker permission denied" } },
      status: 403,
      error: "BytePlus Seed Speech TTS error 45000000: speaker permission denied",
    },
    {
      name: "Volcengine",
      code: 3000,
      params: { appId: "app-id", token: "secret-token" },
      secret: "secret-token",
      failure: { code: 3001, message: "load grant failed" },
      status: 401,
      error: "Volcengine TTS error 3001: load grant failed",
    },
  ])("$name responses", ({ name, code, params, secret, failure, status, error }) => {
    it.each([
      [
        "malformed base64",
        () => Response.json({ code, data: "%%%not-base64!!" }),
        `${name} TTS returned malformed base64 audio data`,
      ],
      ["invalid UTF-8", () => new Response(new Uint8Array([0xff])), TypeError],
      ["provider error", () => Response.json(failure, { status }), error],
      [
        "oversized response",
        () =>
          new Response(
            createClosedChunkStream([new Uint8Array(16 * 1024 * 1024), new Uint8Array(1)]),
          ),
        `${name} TTS response exceeds 16777216 bytes`,
      ],
    ] as const)("rejects %s; redacts and releases", async (_label, response, expected) => {
      const release = mockResponse(response());
      await expect(synthesize(params)).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(typeof expected === "string" ? Error : expected);
        if (typeof expected === "string") {
          expect(err).toHaveProperty("message", expected);
        }
        expect(err).not.toHaveProperty("message", expect.stringContaining(secret));
        return true;
      });
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    ["speed", "0.2", { overrides: { speedRatio: 0.2 } }],
    ["speedratio", "1.25", { overrides: { speedRatio: 1.25 } }],
    ["speed_ratio", "3", { overrides: { speedRatio: 3 } }],
    ["speed", "0x1", { warnings: ['invalid Volcengine speedRatio "0x1"'] }],
  ] as const)("parses %s=%s without mutating prior overrides", (key, value, expected) => {
    const currentOverrides = Object.freeze({ voice: "retained", speedRatio: 0.75 });
    const result = provider.parseDirectiveToken?.({
      key,
      value,
      currentOverrides,
      policy: directivePolicy,
    });
    expect(result).toEqual({ handled: true, ...expected });
  });
});

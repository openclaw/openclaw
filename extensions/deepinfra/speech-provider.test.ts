import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { baseUrl, expectMediaRequest, expectRequestConfig } from "./media-request.test-support.js";
import { buildDeepInfraSpeechProvider } from "./speech-provider.js";

const model = "hexgrad/Kokoro-82M";
const voice = "af_bella";
const context = { cfg: {} as never, timeoutMs: 30_000 };
const http = vi.hoisted(() => ({
  assertOkOrThrowHttpError: vi.fn(async () => {}),
  postJsonRequest: vi.fn(),
  resolveProviderHttpRequestConfig:
    vi.fn<typeof import("openclaw/plugin-sdk/provider-http").resolveProviderHttpRequestConfig>(),
}));

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>();
  http.resolveProviderHttpRequestConfig.mockImplementation(actual.resolveProviderHttpRequestConfig);
  return { ...actual, ...http };
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/provider-http");
  vi.resetModules();
});

describe("deepinfra speech provider", () => {
  afterEach(() => {
    for (const mock of Object.values(http)) {
      mock.mockClear();
    }
    http.postJsonRequest.mockReset();
    vi.unstubAllEnvs();
  });

  it("normalizes provider-owned speech config", () => {
    const provider = buildDeepInfraSpeechProvider();
    expect(provider.defaultTimeoutMs).toBe(120_000);
    const resolved = provider.resolveConfig?.({
      ...context,
      rawConfig: {
        providers: {
          deepinfra: {
            apiKey: "sk-test",
            baseUrl: `${baseUrl}/`,
            modelId: `deepinfra/${model}`,
            voiceId: voice,
            speed: 1.1,
            responseFormat: " MP3 ",
          },
        },
      },
    });
    expect(resolved).toEqual({
      apiKey: "sk-test",
      baseUrl,
      model,
      voice,
      speed: 1.1,
      responseFormat: "mp3",
      extraBody: undefined,
    });
  });

  it("synthesizes OpenAI-compatible speech through DeepInfra", async () => {
    const release = vi.fn(async () => {});
    http.postJsonRequest.mockResolvedValue({
      response: new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      release,
    });

    const result = await buildDeepInfraSpeechProvider().synthesize({
      text: "hello",
      cfg: {
        models: { providers: { deepinfra: { apiKey: "sk-deepinfra", baseUrl: `${baseUrl}/` } } },
      } as never,
      providerConfig: { model, voice, speed: 1.2 },
      target: "voice-note",
      timeoutMs: 12_345,
    });

    expectRequestConfig(http.resolveProviderHttpRequestConfig, "audio");
    expectMediaRequest(http.postJsonRequest, {
      path: "/audio/speech",
      apiKey: "sk-deepinfra",
      timeoutMs: 12_345,
      body: {
        model,
        input: "hello",
        voice,
        response_format: "mp3",
        speed: 1.2,
      },
    });
    expect(result.audioBuffer).toEqual(Buffer.from([1, 2, 3]));
    expect(result).toMatchObject({
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: true,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("uses DEEPINFRA_API_KEY when provider config omits apiKey", () => {
    vi.stubEnv("DEEPINFRA_API_KEY", "sk-env");
    expect(buildDeepInfraSpeechProvider().isConfigured({ ...context, providerConfig: {} })).toBe(
      true,
    );
  });
});

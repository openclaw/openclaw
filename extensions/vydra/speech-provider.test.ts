import { jsonResponse } from "openclaw/plugin-sdk/test-env";
import { bufferedOversizedJsonResponse as oversizedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, describe, expect, it, vi } from "vitest";
import { binaryResponse, stubFetch } from "./provider-test-helpers.js";
import { buildVydraSpeechProvider } from "./speech-provider.js";

describe("vydra speech provider", () => {
  installPinnedHostnameTestHooks();
  const provider = buildVydraSpeechProvider();
  const request = {
    text: "OpenClaw test",
    cfg: {},
    providerConfig: { apiKey: "vydra-test-key" },
    target: "audio-file",
    timeoutMs: 30_000,
  } satisfies Parameters<typeof provider.synthesize>[0];
  const synthesize = (overrides: Partial<Parameters<typeof provider.synthesize>[0]> = {}) =>
    provider.synthesize({ ...request, ...overrides });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exposes the default voice and model", async () => {
    expect(provider.models).toEqual(["elevenlabs/tts"]);
    const voices = await provider.listVoices?.({});
    expect(voices).toEqual([{ id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel" }]);
  });

  it("posts to the tts endpoint and downloads the audio", async () => {
    const fetchMock = stubFetch(
      jsonResponse({ audioUrl: "https://www.vydra.ai/generated/test.mp3" }),
      binaryResponse("mp3-data", "audio/mpeg"),
    );
    const result = await synthesize();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect([url, init.method, init.body]).toEqual([
      "https://www.vydra.ai/api/v1/models/elevenlabs/tts",
      "POST",
      JSON.stringify({ text: "OpenClaw test", voice_id: "21m00Tcm4TlvDq8ikWAM" }),
    ]);
    for (const [, options] of fetchMock.mock.calls) {
      expect(new Headers(options.headers).get("authorization")).toBe("Bearer vydra-test-key");
    }
    expect(result.outputFormat).toBe("mp3");
    expect(result.fileExtension).toBe(".mp3");
    expect(result.audioBuffer).toEqual(Buffer.from("mp3-data"));
  });

  it.each([
    ["configured key", "  configured-key  ", undefined, true],
    ["configured and environment keys", "configured-key", "environment-key", true],
    ["environment key", undefined, "  environment-key  ", true],
    ["blank configured key", " \t ", "environment-key", true],
    ["missing configured key and blank environment", undefined, "\t  \n", false],
    ["blank configured and environment keys", " \t ", "\t  \n", false],
  ] as const)(
    "reports readiness for %s without HTTP",
    async (_name, apiKey, envKey, configured) => {
      vi.stubEnv("VYDRA_API_KEY", envKey);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const providerConfig = { apiKey, baseUrl: "https://vydra.ai/api/v1/" };
      const context = { ...request, providerConfig };
      expect(provider.isConfigured(context)).toBe(configured);
      expect(await provider.isConfiguredAsync?.(context)).toBe(configured);
      if (!configured) {
        await expect(synthesize({ providerConfig })).rejects.toThrow("Vydra API key missing");
      }
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects generated audio downloads that exceed the configured media cap", async () => {
    stubFetch(
      jsonResponse({ audioUrl: "https://cdn.vydra.ai/generated/test.mp3" }),
      binaryResponse("too-large", "audio/mpeg"),
    );
    await expect(
      synthesize({ cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } } }),
    ).rejects.toThrow("Vydra audio download exceeds 1 bytes");
  });

  it("rejects speech synthesis JSON responses that exceed the provider cap", async () => {
    stubFetch(oversizedJsonResponse());
    await expect(synthesize()).rejects.toThrow(
      "Vydra speech synthesis: JSON response exceeds 16777216 bytes",
    );
  });
});

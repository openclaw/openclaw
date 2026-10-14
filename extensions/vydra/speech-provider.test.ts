import { bufferedOversizedJsonResponse as oversizedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, describe, expect, it, vi } from "vitest";
import { binaryResponse, jsonResponse, stubFetch } from "./provider-test-helpers.js";
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

    const result = await provider.synthesize(request);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://www.vydra.ai/api/v1/models/elevenlabs/tts");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(
      JSON.stringify({
        text: "OpenClaw test",
        voice_id: "21m00Tcm4TlvDq8ikWAM",
      }),
    );
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer vydra-test-key");
    const [, downloadInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(new Headers(downloadInit.headers).get("authorization")).toBe("Bearer vydra-test-key");
    expect(result.outputFormat).toBe("mp3");
    expect(result.fileExtension).toBe(".mp3");
    expect(result.audioBuffer).toEqual(Buffer.from("mp3-data"));
  });

  it("does not treat a blank environment API key as configured", () => {
    vi.stubEnv("VYDRA_API_KEY", "   ");

    expect(provider.isConfigured?.({ providerConfig: {}, timeoutMs: 30_000 })).toBe(false);
  });

  it("rejects blank environment API keys before making requests", async () => {
    vi.stubEnv("VYDRA_API_KEY", "\t  \n");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(provider.synthesize({ ...request, providerConfig: {} })).rejects.toThrow(
      "Vydra API key missing",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects generated audio downloads that exceed the configured media cap", async () => {
    stubFetch(
      jsonResponse({ audioUrl: "https://cdn.vydra.ai/generated/test.mp3" }),
      binaryResponse("too-large", "audio/mpeg"),
    );

    await expect(
      provider.synthesize({
        ...request,
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
      }),
    ).rejects.toThrow("Vydra audio download exceeds 1 bytes");
  });

  it("rejects speech synthesis JSON responses that exceed the provider cap", async () => {
    stubFetch(oversizedJsonResponse());

    await expect(provider.synthesize(request)).rejects.toThrow(
      "Vydra speech synthesis: JSON response exceeds 16777216 bytes",
    );
  });
});

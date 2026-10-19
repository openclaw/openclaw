import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const { createGoogleGenAIMock, generateContentMock } = vi.hoisted(() => {
  const generateContentMockLocal =
    vi.fn<(request: GenerateContentRequest) => Promise<GoogleGenerateContentResponse>>();
  const createGoogleGenAIMockLocal = vi.fn((_config: GoogleGenAIConfig) => ({
    models: { generateContent: generateContentMockLocal },
  }));
  return {
    createGoogleGenAIMock: createGoogleGenAIMockLocal,
    generateContentMock: generateContentMockLocal,
  };
});

vi.mock("./google-genai-runtime.js", () => ({
  createGoogleGenAI: createGoogleGenAIMock,
}));

import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import { expectExplicitMusicGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import type { GoogleGenerateContentResponse } from "./generate-content-response.js";
import { buildGoogleMusicGenerationProvider } from "./music-generation-provider.js";

type GoogleGenAIConfig = {
  apiKey?: string;
  httpOptions?: {
    baseUrl?: string;
    timeout?: number;
  };
};

type GenerateContentRequest = {
  model?: string;
  config?: unknown;
};

type GoogleMusicCandidate = NonNullable<GoogleGenerateContentResponse["candidates"]>[number];

function googleMusicResponse(
  parts: NonNullable<GoogleMusicCandidate["content"]>["parts"],
  finishReason?: string,
): GoogleGenerateContentResponse {
  return {
    candidates: [{ content: { parts }, ...(finishReason === undefined ? {} : { finishReason }) }],
  };
}

function googleMusicAudioResponse(bytes = "mp3-bytes") {
  return googleMusicResponse(
    [{ inlineData: { data: Buffer.from(bytes).toString("base64"), mimeType: "audio/mpeg" } }],
    "STOP",
  );
}

type GenerateMusicRequest = Parameters<
  ReturnType<typeof buildGoogleMusicGenerationProvider>["generateMusic"]
>[0];

function generateMusic(overrides: Partial<GenerateMusicRequest> = {}) {
  vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
    apiKey: "google-key",
    source: "env",
    mode: "api-key",
  });
  return buildGoogleMusicGenerationProvider().generateMusic({
    provider: "google",
    model: "lyria-3-clip-preview",
    prompt: "upbeat synthpop anthem",
    cfg: {},
    ...overrides,
  });
}

function googleConfig(google: { apiKey?: string; baseUrl: string }): GenerateMusicRequest["cfg"] {
  return { models: { providers: { google: { models: [], ...google } } } };
}

describe("google music generation provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    generateContentMock.mockReset();
    createGoogleGenAIMock.mockClear();
  });

  afterAll(() => {
    vi.doUnmock("./google-genai-runtime.js");
    vi.resetModules();
  });

  it("declares explicit mode capabilities", () => {
    expectExplicitMusicGenerationCapabilities(buildGoogleMusicGenerationProvider());
  });

  it("advertises Gemini music generation with a config-only Google API key", async () => {
    expect(
      await buildGoogleMusicGenerationProvider().isConfiguredAsync?.({
        cfg: googleConfig({
          apiKey: "google-config-only-key",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        }),
      }),
    ).toBe(true);
  });

  it("submits generation and returns inline audio bytes plus lyrics", async () => {
    const audio = Buffer.from([0xfb, 0xff, 0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
    generateContentMock.mockResolvedValue(
      googleMusicResponse([
        { text: "wake the city up" },
        {
          inlineData: {
            data: audio.toString("base64url"),
            mimeType: "audio/mpeg",
          },
        },
      ]),
    );

    const result = await generateMusic({ instrumental: true });
    const sent = generateContentMock.mock.calls[0]?.[0];
    expect(sent?.model).toBe("lyria-3-clip-preview");
    expect(sent?.config).toEqual({ responseModalities: ["AUDIO", "TEXT"] });
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]?.buffer).toEqual(audio);
    expect(result.tracks[0]?.mimeType).toBe("audio/mpeg");
    expect(result.lyrics).toEqual(["wake the city up"]);
    expect(createGoogleGenAIMock.mock.calls.at(-1)?.[0].apiKey).toBe("google-key");
  });

  it.each([
    ["non-canonical pad bits", "ZE=="],
    ["mixed alphabet", "aGVsbG8+_"],
  ])("rejects %s in inline audio", async (_scenario, data) => {
    generateContentMock.mockResolvedValue(
      googleMusicResponse([{ inlineData: { data, mimeType: "audio/mpeg" } }], "STOP"),
    );

    await expect(generateMusic()).rejects.toThrow(
      "Generated music asset contains malformed base64 audio data",
    );

    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it("shares the configured timeout budget across a no-audio retry", async () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValue(2_500);
    generateContentMock
      .mockResolvedValueOnce(googleMusicResponse([{ text: "[Verse]\nNeon lights" }], "STOP"))
      .mockResolvedValueOnce(googleMusicAudioResponse("recovered-audio"));

    const result = await generateMusic({ timeoutMs: 5_000 });

    expect(generateContentMock).toHaveBeenCalledTimes(2);
    expect(result.tracks[0]?.buffer).toEqual(Buffer.from("recovered-audio"));
    expect(createGoogleGenAIMock.mock.calls.map(([config]) => config.httpOptions?.timeout)).toEqual(
      [5_000, 3_500],
    );
  });

  it("fails after one retry when Lyria keeps returning no audio", async () => {
    generateContentMock.mockResolvedValue(
      googleMusicResponse([{ text: "[Verse]\nStill no audio" }], "STOP"),
    );

    await expect(generateMusic()).rejects.toThrow(
      "Google music generation response missing audio data",
    );

    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      expectedError: "prompt blocked (SAFETY)",
      response: { promptFeedback: { blockReason: "SAFETY" } },
      scenario: "prompt block",
    },
    {
      expectedError: "generation stopped (SAFETY)",
      response: { candidates: [{ finishReason: "SAFETY" }] },
      scenario: "candidate stop",
    },
  ])("does not retry a terminal $scenario response", async ({ expectedError, response }) => {
    generateContentMock.mockResolvedValue(response);

    await expect(generateMusic()).rejects.toThrow(expectedError);

    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry request errors", async () => {
    generateContentMock.mockRejectedValue(new Error("HTTP 400 invalid request"));

    await expect(generateMusic()).rejects.toThrow("HTTP 400 invalid request");

    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "https://generativelanguage.googleapis.com/v1beta",
      "https://generativelanguage.googleapis.com",
    ],
    ["https://proxy.example.com/v1beta/route", "https://proxy.example.com/v1beta/route"],
    [undefined, undefined],
  ])("normalizes only a terminal /v1beta in %s", async (baseUrl, expectedBaseUrl) => {
    generateContentMock.mockResolvedValue(googleMusicAudioResponse());
    await generateMusic({ cfg: baseUrl ? googleConfig({ baseUrl }) : {}, instrumental: true });
    expect(createGoogleGenAIMock.mock.calls.at(-1)?.[0].httpOptions?.baseUrl).toBe(expectedBaseUrl);
  });

  it("rejects unsupported wav output on clip model", async () => {
    await expect(generateMusic({ format: "wav" })).rejects.toThrow("supports mp3 output");
  });
});

import { afterAll, afterEach, expect, it, vi } from "vitest";

const { createGoogleGenAIMock, generateContentMock } = vi.hoisted(() => {
  const generateContent =
    vi.fn<(request: GenerateContentRequest) => Promise<GoogleGenerateContentResponse>>();
  const createGoogleGenAI = vi.fn((_config: GoogleGenAIConfig) => ({
    models: { generateContent },
  }));
  return { createGoogleGenAIMock: createGoogleGenAI, generateContentMock: generateContent };
});

vi.mock("./google-genai-runtime.js", () => ({
  createGoogleGenAI: createGoogleGenAIMock,
}));

import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import { expectExplicitMusicGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import type { GoogleGenerateContentResponse } from "./generate-content-response.js";
import { googleMusicGenerationProvider } from "./music-generation-provider.js";

type GoogleGenAIConfig = { apiKey?: string; httpOptions?: { baseUrl?: string; timeout?: number } };
type GenerateContentRequest = { model?: string; config?: unknown };

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

async function expectGenerationError(message: string, calls = 1) {
  await expect(generateMusic()).rejects.toThrow(message);
  expect(generateContentMock).toHaveBeenCalledTimes(calls);
}

type GenerateMusicRequest = Parameters<(typeof googleMusicGenerationProvider)["generateMusic"]>[0];

function generateMusic(overrides: Partial<GenerateMusicRequest> = {}) {
  vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
    apiKey: "google-key",
    source: "env",
    mode: "api-key",
  });
  return googleMusicGenerationProvider.generateMusic({
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

afterEach(() => {
  vi.restoreAllMocks();
  generateContentMock.mockReset();
  createGoogleGenAIMock.mockClear();
});

afterAll(() => {
  vi.doUnmock("./google-genai-runtime.js");
  vi.resetModules();
});

it("advertises Gemini music generation with a config-only Google API key", async () => {
  expect(
    await googleMusicGenerationProvider.isConfiguredAsync?.({
      cfg: googleConfig({
        apiKey: "google-config-only-key",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      }),
    }),
  ).toBe(true);
});

it("submits generation and returns inline audio bytes plus lyrics", async () => {
  expectExplicitMusicGenerationCapabilities(googleMusicGenerationProvider);
  const audio = Buffer.from([0xfb, 0xff, 0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
  generateContentMock.mockResolvedValue(
    googleMusicResponse([
      { text: "wake the city up" },
      { inlineData: { data: audio.toString("base64url"), mimeType: "audio/mpeg" } },
    ]),
  );

  const result = await generateMusic({
    instrumental: true,
    cfg: googleConfig({ baseUrl: "https://proxy.example.com/v1beta/route" }),
  });
  expect(createGoogleGenAIMock.mock.calls.at(-1)?.[0].httpOptions?.baseUrl).toBe(
    "https://proxy.example.com/v1beta/route",
  );
  expect(generateContentMock.mock.calls[0]?.[0]).toEqual({
    model: "lyria-3-clip-preview",
    contents: expect.anything(),
    config: { responseModalities: ["AUDIO", "TEXT"] },
  });
  expect(result.tracks).toHaveLength(1);
  expect(result).toMatchObject({
    tracks: [{ buffer: audio, mimeType: "audio/mpeg" }],
    lyrics: ["wake the city up"],
  });
  expect(createGoogleGenAIMock.mock.calls.at(-1)?.[0].apiKey).toBe("google-key");
});

it.each([
  ["non-canonical pad bits", "ZE=="],
  ["mixed alphabet", "aGVsbG8+_"],
])("rejects %s in inline audio", async (_scenario, data) => {
  generateContentMock.mockResolvedValue(
    googleMusicResponse([{ inlineData: { data, mimeType: "audio/mpeg" } }], "STOP"),
  );

  await expectGenerationError("Generated music asset contains malformed base64 audio data");
});

it("shares the configured timeout budget across a no-audio retry", async () => {
  vi.spyOn(performance, "now")
    .mockReturnValueOnce(1_000)
    .mockReturnValueOnce(1_000)
    .mockReturnValue(2_500);
  generateContentMock
    .mockResolvedValueOnce(googleMusicResponse([{ text: "[Verse]\nNeon lights" }], "STOP"))
    .mockResolvedValueOnce(googleMusicAudioResponse("recovered-audio"));

  const result = await generateMusic({ timeoutMs: 5_000 });

  expect(generateContentMock).toHaveBeenCalledTimes(2);
  expect(result.tracks[0]?.buffer).toEqual(Buffer.from("recovered-audio"));
  expect(createGoogleGenAIMock.mock.calls.map(([config]) => config.httpOptions?.timeout)).toEqual([
    5_000, 3_500,
  ]);
});

it("fails after one retry when Lyria keeps returning no audio", async () => {
  generateContentMock.mockResolvedValue(
    googleMusicResponse([{ text: "[Verse]\nStill no audio" }], "STOP"),
  );

  await expectGenerationError("Google music generation response missing audio data", 2);
});

it.each([
  ["prompt blocked (SAFETY)", { promptFeedback: { blockReason: "SAFETY" } }],
  ["generation stopped (SAFETY)", { candidates: [{ finishReason: "SAFETY" }] }],
] satisfies Array<[string, GoogleGenerateContentResponse]>)(
  "does not retry %s",
  async (expectedError, response) => {
    generateContentMock.mockResolvedValue(response);
    await expectGenerationError(expectedError);
  },
);

it("does not retry request errors", async () => {
  generateContentMock.mockRejectedValue(new Error("HTTP 400 invalid request"));

  await expectGenerationError("HTTP 400 invalid request");
});

it("rejects unsupported wav output on clip model", async () => {
  await expect(generateMusic({ format: "wav" })).rejects.toThrow("supports mp3 output");
});

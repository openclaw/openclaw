import { afterEach, describe, expect, it, vi } from "vitest";

const { GoogleGenAIMock, generateContentMock } = vi.hoisted(() => {
  const generateContentMock = vi.fn();
  const GoogleGenAIMock = vi.fn(function GoogleGenAI() {
    return {
      models: {
        generateContent: generateContentMock,
      },
    };
  });
  return { GoogleGenAIMock, generateContentMock };
});

vi.mock("@google/genai", () => ({
  GoogleGenAI: GoogleGenAIMock,
}));

import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import { buildGoogleMusicGenerationProvider } from "./music-generation-provider.js";

describe("google music generation provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    generateContentMock.mockReset();
    GoogleGenAIMock.mockClear();
  });

  it("submits generation and returns inline audio bytes plus lyrics", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      source: "env",
      mode: "api-key",
    });
    generateContentMock.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              { text: "wake the city up" },
              {
                inlineData: {
                  data: Buffer.from("mp3-bytes").toString("base64"),
                  mimeType: "audio/mpeg",
                },
              },
            ],
          },
        },
      ],
    });

    const provider = buildGoogleMusicGenerationProvider();
    const result = await provider.generateMusic({
      provider: "google",
      model: "lyria-3-clip-preview",
      prompt: "upbeat synthpop anthem",
      cfg: {},
      instrumental: true,
    });

    expect(generateContentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "lyria-3-clip-preview",
        config: {
          responseModalities: ["AUDIO", "TEXT"],
        },
      }),
    );
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]?.mimeType).toBe("audio/mpeg");
    expect(result.lyrics).toEqual(["wake the city up"]);
    expect(GoogleGenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "google-key",
      }),
    );
  });

  it("strips /v1beta from configured Google baseUrl before passing to GoogleGenAI SDK", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      source: "env",
      mode: "api-key",
    });
    generateContentMock.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  data: Buffer.from("mp3-bytes").toString("base64"),
                  mimeType: "audio/mpeg",
                },
              },
            ],
          },
        },
      ],
    });

    const provider = buildGoogleMusicGenerationProvider();
    await provider.generateMusic({
      provider: "google",
      model: "lyria-3-clip-preview",
      prompt: "chill lofi beats",
      cfg: {
        models: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            },
          },
        },
      },
    });

    // The SDK appends its own /v1beta — if we pass /v1beta in baseUrl the path becomes
    // /v1beta/v1beta/... and the request 404s. The provider must strip it before calling SDK.
    expect(GoogleGenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        httpOptions: expect.objectContaining({
          baseUrl: "https://generativelanguage.googleapis.com",
        }),
      }),
    );
  });

  it("rejects unsupported wav output on clip model", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      source: "env",
      mode: "api-key",
    });
    const provider = buildGoogleMusicGenerationProvider();

    await expect(
      provider.generateMusic({
        provider: "google",
        model: "lyria-3-clip-preview",
        prompt: "ambient ocean",
        cfg: {},
        format: "wav",
      }),
    ).rejects.toThrow("supports mp3 output");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth";
import { buildGoogleImageGenerationProvider } from "./image-generation-provider.js";

describe("Google image-generation provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates image buffers from the Gemini generateContent API", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-test-key",
      source: "env",
      mode: "api-key",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                { text: "generated" },
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: Buffer.from("png-data").toString("base64"),
                  },
                },
              ],
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildGoogleImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "google",
      model: "gemini-3.1-flash-image-preview",
      prompt: "draw a cat",
      cfg: {},
      size: "1536x1024",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: "draw a cat" }],
            },
          ],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: {
              aspectRatio: "3:2",
              imageSize: "2K",
            },
          },
        }),
      }),
    );
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("png-data"),
          mimeType: "image/png",
          fileName: "image-1.png",
        },
      ],
      model: "gemini-3.1-flash-image-preview",
    });
  });

  it("accepts OAuth JSON auth and inline_data responses", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: JSON.stringify({ token: "oauth-token" }),
      source: "profile",
      mode: "token",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  inline_data: {
                    mime_type: "image/jpeg",
                    data: Buffer.from("jpg-data").toString("base64"),
                  },
                },
              ],
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildGoogleImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "google",
      model: "gemini-3.1-flash-image-preview",
      prompt: "draw a dog",
      cfg: {},
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer oauth-token");
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("jpg-data"),
          mimeType: "image/jpeg",
          fileName: "image-1.jpg",
        },
      ],
      model: "gemini-3.1-flash-image-preview",
    });
  });

  it("sends reference images and explicit resolution for edit flows", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-test-key",
      source: "env",
      mode: "api-key",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: Buffer.from("png-data").toString("base64"),
                  },
                },
              ],
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildGoogleImageGenerationProvider();
    await provider.generateImage({
      provider: "google",
      model: "gemini-3-pro-image-preview",
      prompt: "Change only the sky to a sunset.",
      cfg: {},
      resolution: "4K",
      inputImages: [
        {
          buffer: Buffer.from("reference-bytes"),
          mimeType: "image/png",
          fileName: "reference.png",
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: Buffer.from("reference-bytes").toString("base64"),
                  },
                },
                { text: "Change only the sky to a sunset." },
              ],
            },
          ],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: {
              imageSize: "4K",
            },
          },
        }),
      }),
    );
  });

  it("forwards explicit aspect ratio without forcing a default when size is omitted", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-test-key",
      source: "env",
      mode: "api-key",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: Buffer.from("png-data").toString("base64"),
                  },
                },
              ],
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildGoogleImageGenerationProvider();
    await provider.generateImage({
      provider: "google",
      model: "gemini-3-pro-image-preview",
      prompt: "portrait photo",
      cfg: {},
      aspectRatio: "9:16",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: "portrait photo" }],
            },
          ],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: {
              aspectRatio: "9:16",
            },
          },
        }),
      }),
    );
  });
});

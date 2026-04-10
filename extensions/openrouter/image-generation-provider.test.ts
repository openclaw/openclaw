import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenrouterImageGenerationProvider } from "./image-generation-provider.js";

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  assertOkOrThrowHttpErrorMock,
  resolveProviderHttpRequestConfigMock,
} = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "openrouter-key" })),
  postJsonRequestMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  resolveProviderHttpRequestConfigMock: vi.fn((params) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: Boolean(params.allowPrivateNetwork),
    headers: new Headers(params.defaultHeaders),
    dispatcherPolicy: undefined,
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  postJsonRequest: postJsonRequestMock,
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
}));

function makeImageDataUrl(content: string): string {
  return `data:image/png;base64,${Buffer.from(content).toString("base64")}`;
}

describe("openrouter image generation provider", () => {
  afterEach(() => {
    resolveApiKeyForProviderMock.mockClear();
    postJsonRequestMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
  });

  it("exposes correct provider metadata", () => {
    const provider = buildOpenrouterImageGenerationProvider();
    expect(provider.id).toBe("openrouter");
    expect(provider.label).toBe("OpenRouter");
    expect(provider.defaultModel).toBe("google/gemini-2.5-flash-image");
    expect(provider.models).toContain("google/gemini-2.5-flash-image");
    expect(provider.models).toContain("black-forest-labs/flux.2-pro");
    expect(provider.capabilities.generate.supportsAspectRatio).toBe(true);
    expect(provider.capabilities.generate.supportsResolution).toBe(true);
    expect(provider.capabilities.edit.enabled).toBe(false);
  });

  it("generates an image and parses base64 data URL response", async () => {
    const imageUrl = makeImageDataUrl("png-bytes");
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Here is your image",
                images: [
                  {
                    type: "image_url",
                    image_url: { url: imageUrl },
                  },
                ],
              },
            },
          ],
        }),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildOpenrouterImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openrouter",
      model: "google/gemini-2.5-flash-image",
      prompt: "Draw a lobster",
      cfg: {},
    });

    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.mimeType).toBe("image/png");
    expect(result.images[0]?.buffer.toString()).toBe("png-bytes");
    expect(result.images[0]?.fileName).toBe("image-1.png"); // PNG from data URL MIME type
    expect(result.model).toBe("google/gemini-2.5-flash-image");

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://openrouter.ai/api/v1/chat/completions",
        body: expect.objectContaining({
          model: "google/gemini-2.5-flash-image",
          modalities: ["image", "text"],
          messages: [{ role: "user", content: "Draw a lobster" }],
        }),
      }),
    );
  });

  it("passes aspect_ratio and image_size via image_config", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          choices: [
            {
              message: {
                images: [
                  {
                    type: "image_url",
                    image_url: { url: makeImageDataUrl("bytes") },
                  },
                ],
              },
            },
          ],
        }),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildOpenrouterImageGenerationProvider();
    await provider.generateImage({
      provider: "openrouter",
      model: "google/gemini-2.5-flash-image",
      prompt: "A sunset",
      cfg: {},
      aspectRatio: "16:9",
      resolution: "2K",
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          image_config: {
            aspect_ratio: "16:9",
            image_size: "2K",
          },
        }),
      }),
    );
  });

  it("throws when response contains no images", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          choices: [{ message: { content: "Sorry, no image" } }],
        }),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildOpenrouterImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "openrouter",
        model: "google/gemini-2.5-flash-image",
        prompt: "a tree",
        cfg: {},
      }),
    ).rejects.toThrow("OpenRouter image generation response missing image data");
  });

  it("throws when API key is missing", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({ apiKey: "" });

    const provider = buildOpenrouterImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "openrouter",
        model: "google/gemini-2.5-flash-image",
        prompt: "a tree",
        cfg: {},
      }),
    ).rejects.toThrow("OpenRouter API key missing");
  });
});

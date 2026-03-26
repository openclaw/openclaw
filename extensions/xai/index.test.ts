import * as providerAuth from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/extensions/provider-registration.js";
import { buildXaiImageGenerationProvider } from "./image-generation-provider.js";
import plugin from "./index.js";

const registerXaiPlugin = () =>
  registerProviderPlugin({
    plugin,
    id: "xai",
    name: "xAI Plugin",
  });

describe("xai plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers xai provider, image generation, and no unrelated bundled capabilities", () => {
    const { providers, speechProviders, mediaProviders, imageProviders } = registerXaiPlugin();

    expect(providers).toHaveLength(1);
    expect(
      providers.map(
        (provider) =>
          // oxlint-disable-next-line typescript/no-explicit-any
          (provider as any).id,
      ),
    ).toEqual(["xai"]);
    expect(speechProviders).toHaveLength(0);
    expect(mediaProviders).toHaveLength(0);
    expect(imageProviders).toHaveLength(1);

    const imageProvider = requireRegisteredProvider<
      ReturnType<typeof buildXaiImageGenerationProvider>
    >(imageProviders, "xai", "image provider");
    expect(imageProvider.aliases).toContain("xai-images");
    expect(imageProvider.models).toEqual(
      expect.arrayContaining(["grok-imagine-image", "grok-imagine-image-pro"]),
    );
  });

  it("generates xAI images with base64 output and moderation metadata", async () => {
    const resolveApiKeySpy = vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "xai-test-key",
      source: "env",
      mode: "api-key",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: "grok-imagine-image",
        respect_moderation: true,
        data: [
          {
            b64_json: Buffer.from("jpg-data").toString("base64"),
            revised_prompt: "revised prompt",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildXaiImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "xai",
      model: "grok-imagine-image",
      prompt: "A neon city skyline.",
      cfg: {},
      count: 3,
      aspectRatio: "16:9",
      resolution: "2K",
    });

    expect(resolveApiKeySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "xai",
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.x.ai/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "grok-imagine-image",
          prompt: "A neon city skyline.",
          n: 3,
          response_format: "b64_json",
          aspect_ratio: "16:9",
          resolution: "2k",
        }),
      }),
    );
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("jpg-data"),
          mimeType: "image/jpeg",
          fileName: "image-1.jpg",
          revisedPrompt: "revised prompt",
        },
      ],
      model: "grok-imagine-image",
      metadata: {
        respectModeration: true,
      },
    });
  });

  it("supports edit requests and xai-images auth fallback", async () => {
    const resolveApiKeySpy = vi
      .spyOn(providerAuth, "resolveApiKeyForProvider")
      .mockRejectedValueOnce(new Error('No API key found for provider "xai-images".'))
      .mockResolvedValueOnce({
        apiKey: "fallback-xai-key",
        source: "env",
        mode: "api-key",
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: "grok-imagine-image-pro",
          data: [{ url: "https://cdn.x.ai/generated.jpg" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "image/jpeg" }),
        arrayBuffer: async () => Buffer.from("downloaded-jpg"),
      });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildXaiImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "xai-images",
      model: "grok-imagine-image-pro",
      prompt: "Combine these subjects into one portrait.",
      cfg: {
        models: {
          providers: {
            "xai-images": {
              baseUrl: "https://api.x.ai/v1",
              apiKey: "${GROK_IMAGINE_API_KEY}",
              models: [],
            },
          },
        },
      },
      inputImages: [
        {
          buffer: Buffer.from("ref-one"),
          mimeType: "image/png",
        },
        {
          buffer: Buffer.from("ref-two"),
          mimeType: "image/jpeg",
        },
      ],
      aspectRatio: "3:2",
      resolution: "2K",
    });

    expect(resolveApiKeySpy.mock.calls.map((call) => call[0]?.provider)).toEqual([
      "xai-images",
      "xai",
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.x.ai/v1/images/edits",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "grok-imagine-image-pro",
          prompt: "Combine these subjects into one portrait.",
          n: 1,
          response_format: "b64_json",
          aspect_ratio: "3:2",
          resolution: "2k",
          images: [
            {
              type: "image_url",
              url: `data:image/png;base64,${Buffer.from("ref-one").toString("base64")}`,
            },
            {
              type: "image_url",
              url: `data:image/jpeg;base64,${Buffer.from("ref-two").toString("base64")}`,
            },
          ],
        }),
      }),
    );
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("downloaded-jpg"),
          mimeType: "image/jpeg",
          fileName: "image-1.jpg",
        },
      ],
      model: "grok-imagine-image-pro",
    });
  });
});

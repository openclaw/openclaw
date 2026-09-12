import { generateImage } from "openclaw/plugin-sdk/image-generation-runtime";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { buildFalImageGenerationProvider } from "./image-generation-provider.js";

function sourceImage(buffer: string) {
  return { buffer: Buffer.from(buffer), mimeType: "image/png" };
}

function mockGeneratedImage() {
  fetchWithSsrFGuardMock
    .mockResolvedValueOnce({
      response: Response.json({ images: [{ url: "https://v3.fal.media/out.webp" }] }),
      release: vi.fn(async () => {}),
    })
    .mockResolvedValueOnce({
      response: new Response(Buffer.from("image"), {
        headers: { "content-type": "image/webp" },
      }),
      release: vi.fn(async () => {}),
    });
}

describe("fal GPT Image 2.5", () => {
  let provider: ReturnType<typeof buildFalImageGenerationProvider>;

  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    provider = buildFalImageGenerationProvider();
  });

  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    vi.restoreAllMocks();
  });

  it.each([
    ["1:1", 1536, 1536],
    ["3:2", 1536, 1024],
    ["2:3", 1024, 1536],
    ["4:3", 1536, 1152],
    ["3:4", 1152, 1536],
    ["16:9", 1536, 864],
    ["9:16", 864, 1536],
    ["5:4", 1536, 1232],
    ["4:5", 1232, 1536],
    ["2.35:1", 1536, 656],
    ["21:9", 1536, 656],
  ] as const)(
    "maps aspect ratio %s to valid generation and edit dimensions",
    async (aspectRatio, width, height) => {
      for (const variant of ["flare", "sunburst"]) {
        fetchWithSsrFGuardMock.mockReset();
        mockGeneratedImage();
        await generateImage(
          {
            cfg: {},
            modelOverride: `fal/openai/gpt-image-2.5/${variant}/text-to-image`,
            prompt: "A sticker",
            aspectRatio,
            ...(variant === "sunburst"
              ? { inputImages: [sourceImage("reference")], inferredResolution: "4K" as const }
              : {}),
          },
          { getProvider: () => provider, listProviders: () => [provider] },
        );
        const body = JSON.parse(String(fetchWithSsrFGuardMock.mock.calls[0]?.[0].init.body));
        expect(body.image_size).toEqual({ width, height });
        expect(body).not.toHaveProperty("resolution");
      }
    },
  );

  it.each(["flare", "sunburst"])("generates and edits %s through runtime", async (variant) => {
    const model = `openai/gpt-image-2.5/${variant}/text-to-image`;
    const refs = Array.from({ length: 16 }, () => sourceImage("reference"));
    for (const mode of ["generate", "edit", "explicit-edit"] as const) {
      fetchWithSsrFGuardMock.mockReset();
      mockGeneratedImage();
      const selectedModel =
        mode === "explicit-edit" ? model.replace("/text-to-image", "/edit") : model;
      const result = await generateImage(
        {
          cfg: {},
          modelOverride: `fal/${selectedModel}`,
          prompt: "A transparent sticker",
          quality: variant === "flare" ? "xhigh" : "max",
          outputFormat: "webp",
          background: "transparent",
          size: mode === "generate" ? "1536x864" : "auto",
          ...(mode !== "generate" ? { inputImages: refs, inferredResolution: "4K" as const } : {}),
        },
        { getProvider: () => provider, listProviders: () => [provider] },
      );
      const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
      expect(request.url).toBe(
        `https://fal.run/${mode === "generate" ? model : model.replace("/text-to-image", "/edit")}`,
      );
      expect(request.auditContext).toBe("fal-image-generate");
      expect(request.policy).toBeUndefined();
      expect(request.init.method).toBe("POST");
      const headers = new Headers(request.init.headers);
      expect(headers.get("authorization")).toBe("Key fal-test-key");
      expect(headers.get("content-type")).toBe("application/json");
      expect(JSON.parse(String(request.init.body))).toEqual({
        prompt: "A transparent sticker",
        num_images: 1,
        quality: variant === "flare" ? "xhigh" : "max",
        output_format: "webp",
        background: "transparent",
        image_size: mode === "generate" ? { width: 1536, height: 864 } : "auto",
        ...(mode !== "generate"
          ? {
              image_urls: refs.map(
                (image) => `data:image/png;base64,${image.buffer.toString("base64")}`,
              ),
            }
          : {}),
      });
      expect(result.ignoredOverrides).toEqual([]);
      expect(result.images[0]?.buffer.toString()).toBe("image");
    }
    fetchWithSsrFGuardMock.mockReset();
    await expect(
      generateImage(
        {
          cfg: {},
          modelOverride: `fal/${model}`,
          prompt: "Too many references",
          inputImages: [...refs, sourceImage("extra")],
        },
        { getProvider: () => provider, listProviders: () => [provider], log: { warn: vi.fn() } },
      ),
    ).rejects.toThrow("16");
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it.each([
    { size: "1025x1024" },
    { size: "1024x624" },
    { size: "4096x2048" },
    { size: "2896x2896" },
    { size: "3072x768" },
    { size: "bogus" },
    { aspectRatio: "4:1" },
    { resolution: "4K" as const },
  ])("rejects incompatible geometry before requesting fal: %j", async (geometry) => {
    await expect(
      provider.generateImage({
        provider: "fal",
        model: "openai/gpt-image-2.5/flare/text-to-image",
        cfg: {},
        prompt: "A sticker",
        ...geometry,
      }),
    ).rejects.toThrow(/fal GPT Image 2.5.*size/);
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("keeps edit auto geometry when no size is requested", async () => {
    mockGeneratedImage();
    await provider.generateImage({
      provider: "fal",
      cfg: {},
      model: "openai/gpt-image-2.5/sunburst/text-to-image",
      prompt: "A sticker",
      inputImages: [sourceImage("reference")],
    });
    const body = JSON.parse(String(fetchWithSsrFGuardMock.mock.calls[0]?.[0].init.body));
    expect(body).not.toHaveProperty("image_size");
    expect(body).not.toHaveProperty("resolution");
  });
});

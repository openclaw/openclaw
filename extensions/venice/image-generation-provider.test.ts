import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

import { buildVeniceImageGenerationProvider } from "./image-generation-provider.js";
import { setVeniceImageFetchGuardForTesting } from "./test-support.js";

// 1x1 transparent PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function lastRequest() {
  const request = fetchWithSsrFGuardMock.mock.calls.at(-1)?.[0];
  if (!request) {
    throw new Error("expected a venice fetch request");
  }
  return request;
}

describe("venice image-generation provider", () => {
  function stubLiveImageCatalog(rows: unknown[] = []) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: rows })),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    stubLiveImageCatalog();
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "venice-test-key",
      source: "env",
      mode: "api-key",
    });
    setVeniceImageFetchGuardForTesting(fetchWithSsrFGuardMock);
  });

  afterEach(() => {
    setVeniceImageFetchGuardForTesting(null);
    clearLiveCatalogCacheForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mockImageResponse(): void {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ id: "img-1", images: [PNG_BASE64] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      release: vi.fn(async () => {}),
    });
  }

  it("posts to the venice image endpoint and decodes base64 images", async () => {
    mockImageResponse();
    const provider = buildVeniceImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "venice",
      model: "lustify-v8",
      prompt: "a serene mountain lake",
      cfg: {} as never,
      aspectRatio: "16:9",
      count: 2,
    });

    const request = lastRequest();
    expect(request.url).toBe("https://api.venice.ai/api/v1/image/generate");
    expect(request.auditContext).toBe("venice-image-generate");
    expect(request.policy).toEqual({ allowedHostnames: ["api.venice.ai"] });
    expect(request.init?.method).toBe("POST");
    expect(new Headers(request.init?.headers).get("authorization")).toBe("Bearer venice-test-key");

    const body = JSON.parse(String(request.init?.body));
    expect(body).toMatchObject({
      model: "lustify-v8",
      prompt: "a serene mountain lake",
      // lustify-v8 is pixel-addressed, so the ratio becomes dimensions even
      // when the live catalog is unavailable.
      width: 1280,
      height: 720,
      variants: 2,
      return_binary: false,
      // Uncensored-by-default: the Venice plugin disables safe_mode.
      safe_mode: false,
    });
    expect(body.aspect_ratio).toBeUndefined();

    expect(result.model).toBe("lustify-v8");
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.mimeType).toBe("image/png");
    expect(result.images[0]?.buffer.length).toBeGreaterThan(0);
  });

  it("maps an explicit size to proportionally fitted width/height and defaults the model", async () => {
    mockImageResponse();
    const provider = buildVeniceImageGenerationProvider();
    await provider.generateImage({
      provider: "venice",
      model: "",
      prompt: "test",
      cfg: {} as never,
      size: "2048x768",
    });

    const body = JSON.parse(String(lastRequest().init?.body));
    expect(body.model).toBe(provider.defaultModel);
    // 2048x768 scales together to the 1280px edge cap, then snaps to the divisor.
    expect(body.width).toBe(1280);
    expect(body.height).toBe(480);
    expect(body.aspect_ratio).toBeUndefined();
    expect(body.variants).toBe(1);
  });

  it("sends an aspect ratio instead of pixel dimensions to ratio-addressed models", async () => {
    stubLiveImageCatalog([
      {
        id: "qwen-image-2",
        object: "model",
        type: "image",
        model_spec: {
          constraints: { aspectRatios: ["1:1", "16:9", "9:16"], widthHeightDivisor: 1 },
        },
      },
    ]);
    mockImageResponse();
    const provider = buildVeniceImageGenerationProvider();
    await provider.generateImage({
      provider: "venice",
      model: "qwen-image-2",
      prompt: "test",
      cfg: {} as never,
      size: "1280x720",
    });

    const body = JSON.parse(String(lastRequest().init?.body));
    expect(body.width).toBeUndefined();
    expect(body.height).toBeUndefined();
    expect(body.aspect_ratio).toBe("16:9");
  });

  it("sends resolution tiers only to models that publish them", async () => {
    stubLiveImageCatalog([
      {
        id: "qwen-image-2",
        object: "model",
        type: "image",
        model_spec: { constraints: { aspectRatios: ["1:1", "16:9"], widthHeightDivisor: 1 } },
      },
      {
        id: "nano-banana-pro",
        object: "model",
        type: "image",
        model_spec: {
          constraints: { aspectRatios: ["1:1", "16:9"], resolutions: ["1K", "2K", "4K"] },
        },
      },
    ]);
    const provider = buildVeniceImageGenerationProvider();
    for (const [model, expected] of [
      ["qwen-image-2", undefined],
      ["nano-banana-pro", "2K"],
    ] as const) {
      mockImageResponse();
      await provider.generateImage({
        provider: "venice",
        model,
        prompt: "test",
        cfg: {} as never,
        aspectRatio: "16:9",
        resolution: "2K",
      });
      const body = JSON.parse(String(lastRequest().init?.body));
      expect(body.aspect_ratio).toBe("16:9");
      expect(body.resolution).toBe(expected);
    }
  });

  it("derives pixel dimensions from an aspect ratio for pixel-addressed models", async () => {
    stubLiveImageCatalog([
      {
        id: "venice-sd35",
        object: "model",
        type: "image",
        model_spec: { constraints: { widthHeightDivisor: 16 } },
      },
    ]);
    mockImageResponse();
    const provider = buildVeniceImageGenerationProvider();
    await provider.generateImage({
      provider: "venice",
      model: "venice-sd35",
      prompt: "test",
      cfg: {} as never,
      aspectRatio: "16:9",
      resolution: "2K",
    });

    const body = JSON.parse(String(lastRequest().init?.body));
    expect(body).toMatchObject({ width: 1280, height: 720 });
    expect(body.aspect_ratio).toBeUndefined();
    expect(body.resolution).toBeUndefined();

    // A resolution tier alone becomes a square long edge on pixel models.
    mockImageResponse();
    await provider.generateImage({
      provider: "venice",
      model: "venice-sd35",
      prompt: "test",
      cfg: {} as never,
      resolution: "1K",
    });
    expect(JSON.parse(String(lastRequest().init?.body))).toMatchObject({
      width: 1024,
      height: 1024,
    });

    // An explicit size snaps to the model's dimension divisor.
    mockImageResponse();
    await provider.generateImage({
      provider: "venice",
      model: "venice-sd35",
      prompt: "test",
      cfg: {} as never,
      size: "1000x1000",
    });
    expect(JSON.parse(String(lastRequest().init?.body))).toMatchObject({ width: 992, height: 992 });
  });

  it("falls back to an aspect ratio for unknown models when the catalog is unavailable", async () => {
    mockImageResponse();
    const provider = buildVeniceImageGenerationProvider();
    await provider.generateImage({
      provider: "venice",
      model: "brand-new-ratio-model",
      prompt: "test",
      cfg: {} as never,
      size: "1280x720",
    });
    const body = JSON.parse(String(lastRequest().init?.body));
    expect(body.width).toBeUndefined();
    expect(body.aspect_ratio).toBe("16:9");

    // Oversized sizes keep their ratio rather than being clamped per edge.
    mockImageResponse();
    await provider.generateImage({
      provider: "venice",
      model: "brand-new-ratio-model",
      prompt: "test",
      cfg: {} as never,
      size: "2048x1152",
    });
    expect(JSON.parse(String(lastRequest().init?.body)).aspect_ratio).toBe("16:9");
  });

  it("reports availability from a key supplied only through provider configuration", () => {
    const provider = buildVeniceImageGenerationProvider();
    const cfg = { models: { providers: { venice: { apiKey: "cfg-only-key" } } } } as never;
    expect(provider.isConfigured?.({ cfg })).toBe(true);
    expect(provider.isConfigured?.({ cfg: {} as never })).toBe(false);
  });

  it("rejects an oversized image response before decoding it", async () => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      // The bounded reader allows a 1 MiB JSON envelope on top of the image cap.
      response: new Response(JSON.stringify({ images: ["A".repeat(2 * 1024 * 1024)] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      release: vi.fn(async () => {}),
    });
    const provider = buildVeniceImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "venice",
        model: "",
        prompt: "test",
        // 1 KiB image cap => a 2 MiB inline payload must be refused.
        cfg: { agents: { defaults: { mediaMaxMb: 1 / 1024 } } } as never,
      }),
    ).rejects.toThrow(/exceed|too large|limit/i);
  });

  it("throws on a malformed response", async () => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ images: "nope" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      release: vi.fn(async () => {}),
    });
    const provider = buildVeniceImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "venice",
        model: "",
        prompt: "test",
        cfg: {} as never,
      }),
    ).rejects.toThrow(/malformed/);
  });

  it("routes reference-image requests to /image/edit and decodes the binary reply", async () => {
    const pngBytes = Buffer.from(PNG_BASE64, "base64");
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(pngBytes, { status: 200, headers: { "Content-Type": "image/png" } }),
      release: vi.fn(async () => {}),
    });
    const provider = buildVeniceImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "venice",
      // Core forwards the generation default; the edit path must swap it out.
      model: provider.defaultModel ?? "",
      prompt: "give the fox a red scarf",
      cfg: {} as never,
      aspectRatio: "1:1",
      inputImages: [{ buffer: Buffer.from("source"), mimeType: "image/png" }],
    });

    const request = lastRequest();
    expect(request.url).toBe("https://api.venice.ai/api/v1/image/edit");
    expect(request.auditContext).toBe("venice-image-edit");
    const body = JSON.parse(String(request.init?.body));
    expect(body).toEqual({
      model: "firered-image-edit",
      prompt: "give the fox a red scarf",
      image: Buffer.from("source").toString("base64"),
      output_format: "png",
      safe_mode: false,
      aspect_ratio: "1:1",
    });
    expect(result.model).toBe("firered-image-edit");
    expect(result.images).toEqual([
      { buffer: pngBytes, mimeType: "image/png", fileName: "image-1.png" },
    ]);
  });

  it("routes a configured generation model to the edit default when editing", async () => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(Buffer.from(PNG_BASE64, "base64"), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
      release: vi.fn(async () => {}),
    });
    const provider = buildVeniceImageGenerationProvider();
    await provider.generateImage({
      provider: "venice",
      model: "lustify-v8",
      prompt: "test",
      cfg: {} as never,
      inputImages: [{ buffer: Buffer.from("source"), mimeType: "image/png" }],
    });
    expect(JSON.parse(String(lastRequest().init?.body)).model).toBe("firered-image-edit");
  });

  it("keeps an explicit edit model when editing", async () => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(Buffer.from(PNG_BASE64, "base64"), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
      release: vi.fn(async () => {}),
    });
    const provider = buildVeniceImageGenerationProvider();
    await provider.generateImage({
      provider: "venice",
      model: "qwen-edit-uncensored",
      prompt: "test",
      cfg: {} as never,
      inputImages: [{ buffer: Buffer.from("source"), mimeType: "image/png" }],
    });
    expect(JSON.parse(String(lastRequest().init?.body)).model).toBe("qwen-edit-uncensored");
    expect(provider.capabilities.edit).toMatchObject({ enabled: true, maxInputImages: 1 });
  });
});

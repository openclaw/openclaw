import type { ImageGenerationRequest } from "openclaw/plugin-sdk/image-generation";
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

const defaultRequest: ImageGenerationRequest = {
  provider: "fal",
  model: "fal-ai/flux/dev",
  prompt: "draw a cat",
  cfg: {},
};

const falApiKey = { apiKey: "fal-test-key", source: "env", mode: "api-key" } as const;

function releasedJson(payload: unknown, release = vi.fn(async () => {})) {
  return { response: Response.json(payload), release };
}

function releasedImage(data: BodyInit, release = vi.fn(async () => {})) {
  return {
    response: new Response(data, { status: 200, headers: { "content-type": "image/png" } }),
    release,
  };
}

function expectFalJsonPost(params: { url: string; body: Record<string, unknown> }) {
  const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
  if (!request) {
    throw new Error("expected fal fetch request #1");
  }
  expect(request.url).toBe(params.url);
  expect(request.auditContext).toBe("fal-image-generate");
  expect(request.policy).toBeUndefined();
  expect(request.init?.method).toBe("POST");
  const headers = new Headers(request.init?.headers);
  expect(headers.get("authorization")).toBe("Key fal-test-key");
  expect(headers.get("content-type")).toBe("application/json");
  expect(JSON.parse(String(request.init?.body))).toEqual(params.body);
}

function expectFalDownload(params: { call: number; url: string; timeoutMs?: number }) {
  expect(fetchWithSsrFGuardMock.mock.calls[params.call - 1]?.[0]).toEqual({
    url: params.url,
    timeoutMs: params.timeoutMs ?? 30_000,
    policy: undefined,
    auditContext: "fal-image-download",
  });
}

describe("fal image-generation provider", () => {
  let provider: ReturnType<typeof buildFalImageGenerationProvider>;

  function sourceImage(buffer: string, mimeType = "image/png", fileName?: string) {
    return { buffer: Buffer.from(buffer), mimeType, ...(fileName ? { fileName } : {}) };
  }

  function generateFalImage(
    fileName: string,
    imageData: string,
    request: Omit<ImageGenerationRequest, "provider" | "model" | "cfg"> &
      Partial<Pick<ImageGenerationRequest, "model" | "cfg">>,
  ) {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(
        releasedJson({ images: [{ url: `https://v3.fal.media/files/example/${fileName}` }] }),
      )
      .mockResolvedValueOnce(releasedImage(Buffer.from(imageData)));
    return provider.generateImage({
      ...defaultRequest,
      ...request,
    });
  }

  async function expectImageRequest(
    request: Partial<ImageGenerationRequest>,
    url: string,
    body: Record<string, unknown>,
  ) {
    await generateFalImage("generated.png", "image", { ...defaultRequest, ...request });
    expectFalJsonPost({
      url,
      body: { prompt: defaultRequest.prompt, num_images: 1, output_format: "png", ...body },
    });
  }

  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    vi.clearAllMocks();
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue(falApiKey);
    provider = buildFalImageGenerationProvider();
  });

  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    {
      model: "krea/v2/large/text-to-image",
      requested: "21:9",
      applied: "2.35:1",
      mode: "style",
    },
    {
      model: "fal-ai/nano-banana-2",
      requested: "2.35:1",
      applied: "21:9",
      mode: "generate",
    },
  ])("normalizes unsupported $model geometry before provider submission", async (testCase) => {
    const image = sourceImage("reference");
    const inputImages = testCase.mode === "generate" ? undefined : [image];
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(releasedJson({ images: [{ url: "https://v3.fal.media/out.png" }] }))
      .mockResolvedValueOnce(releasedImage(Buffer.from("png-data")));

    const result = await generateImage(
      {
        cfg: {
          agents: {
            defaults: {
              mediaModels: { image: { primary: `fal/${testCase.model}` } },
            },
          },
        },
        prompt: "preserve the closest native image shape",
        aspectRatio: testCase.requested,
        ...(inputImages ? { inputImages } : {}),
      },
      {
        getProvider: () => provider,
        listProviders: () => [provider],
      },
    );

    expect(result.normalization?.aspectRatio).toEqual({
      requested: testCase.requested,
      applied: testCase.applied,
    });
    expectFalJsonPost({
      url: `https://fal.run/${testCase.model}`,
      body: {
        prompt: "preserve the closest native image shape",
        aspect_ratio: testCase.applied,
        ...(testCase.mode === "style"
          ? {
              creativity: "medium",
              image_style_references: [
                { image_url: `data:image/png;base64,${image.buffer.toString("base64")}` },
              ],
            }
          : testCase.mode === "edit"
            ? {
                num_images: 1,
                output_format: "png",
                image_urls: [`data:image/png;base64,${image.buffer.toString("base64")}`],
              }
            : testCase.model.startsWith("krea/")
              ? { creativity: "medium" }
              : { num_images: 1, output_format: "png" }),
      },
    });
  });

  it("generates image buffers from the fal sync API", async () => {
    const releaseRequest = vi.fn(async () => {});
    const releaseDownload = vi.fn(async () => {});
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(
        releasedJson(
          {
            images: [
              {
                url: "https://v3.fal.media/files/example/generated.png",
                content_type: "image/png",
              },
            ],
            prompt: "draw a cat",
          },
          releaseRequest,
        ),
      )
      .mockResolvedValueOnce(releasedImage(Buffer.from("png-data"), releaseDownload));

    const result = await provider.generateImage({
      ...defaultRequest,
      count: 2,
      size: "1536x1024",
      outputFormat: "jpeg",
    });

    expectFalJsonPost({
      url: "https://fal.run/fal-ai/flux/dev",
      body: {
        prompt: "draw a cat",
        image_size: { width: 1536, height: 1024 },
        num_images: 2,
        output_format: "jpeg",
      },
    });
    expectFalDownload({ call: 2, url: "https://v3.fal.media/files/example/generated.png" });
    expect(releaseRequest).toHaveBeenCalledTimes(1);
    expect(releaseDownload).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("png-data"),
          mimeType: "image/png",
          fileName: "image-1.png",
        },
      ],
      model: "fal-ai/flux/dev",
      metadata: { prompt: "draw a cat" },
    });
  });

  it("shares an explicit operation deadline across generated image downloads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T00:00:00Z"));
    vi.mocked(providerAuth.resolveApiKeyForProvider).mockImplementation(async () => {
      vi.advanceTimersByTime(5_000);
      return falApiKey;
    });
    fetchWithSsrFGuardMock
      .mockImplementationOnce(async () => {
        vi.advanceTimersByTime(10_000);
        return releasedJson({
          images: [
            { url: "https://v3.fal.media/files/example/first.png" },
            { url: "https://v3.fal.media/files/example/second.png" },
          ],
        });
      })
      .mockImplementationOnce(async () => {
        vi.advanceTimersByTime(20_000);
        return releasedImage(Buffer.from("first"));
      })
      .mockResolvedValueOnce(releasedImage(Buffer.from("second")));

    const result = await provider.generateImage({
      ...defaultRequest,
      prompt: "draw two cats",
      timeoutMs: 180_000,
      count: 2,
    });

    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.timeoutMs).toBe(175_000);
    expectFalDownload({
      call: 2,
      url: "https://v3.fal.media/files/example/first.png",
      timeoutMs: 165_000,
    });
    expectFalDownload({
      call: 3,
      url: "https://v3.fal.media/files/example/second.png",
      timeoutMs: 145_000,
    });
    expect(result.images.map((image) => image.buffer.toString())).toEqual(["first", "second"]);
  });

  it("rejects generated image downloads that exceed the configured media cap", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(
        releasedJson({ images: [{ url: "https://v3.fal.media/files/example/generated.png" }] }),
      )
      .mockResolvedValueOnce(releasedImage(Buffer.from("too-large")));

    await expect(
      provider.generateImage({
        ...defaultRequest,
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
      }),
    ).rejects.toThrow("fal generated image download exceeds 1 bytes");
  });

  it("wraps wrong-shape successful fal image responses", async () => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce(
      releasedJson({ images: { url: "https://example.test/image.png" } }),
    );

    await expect(provider.generateImage(defaultRequest)).rejects.toThrow(
      "fal image generation response malformed",
    );
  });

  it("uses image-to-image endpoint and data-uri input for edits", async () => {
    await expectImageRequest(
      {
        resolution: "2K",
        inputImages: [sourceImage("source-image", "image/jpeg", "source.jpg")],
      },
      "https://fal.run/fal-ai/flux/dev/image-to-image",
      {
        image_size: { width: 2048, height: 2048 },
        image_url: `data:image/jpeg;base64,${Buffer.from("source-image").toString("base64")}`,
      },
    );
  });

  it("routes 10 GPT Image 2 references through /edit with image_urls", async () => {
    const inputImages = Array.from({ length: 10 }, (_, index) =>
      sourceImage(`ref-${index}`, index % 2 ? "image/jpeg" : "image/png"),
    );
    await expectImageRequest(
      {
        model: "openai/gpt-image-2",
        aspectRatio: "16:9",
        inputImages,
      },
      "https://fal.run/openai/gpt-image-2/edit",
      {
        image_size: "landscape_16_9",
        image_urls: inputImages.map(
          (image) => `data:${image.mimeType};base64,${image.buffer.toString("base64")}`,
        ),
      },
    );
  });

  it.each([
    { model: "fal-ai/nano-banana", resolution: undefined },
    { model: "fal-ai/nano-banana-2", resolution: "2K" as const },
  ])("routes $model edits through /edit with model geometry", async ({ model, resolution }) => {
    await expectImageRequest(
      {
        model,
        aspectRatio: "9:16",
        ...(resolution ? { resolution } : {}),
        inputImages: [sourceImage("first"), sourceImage("second")],
      },
      `https://fal.run/${model}/edit`,
      {
        aspect_ratio: "9:16",
        ...(resolution ? { resolution } : {}),
        image_urls: [
          `data:image/png;base64,${Buffer.from("first").toString("base64")}`,
          `data:image/png;base64,${Buffer.from("second").toString("base64")}`,
        ],
      },
    );
  });

  it("routes Nano Banana 2 Lite edits through /edit with image_urls", async () => {
    await expectImageRequest(
      {
        model: "google/nano-banana-2-lite",
        aspectRatio: "3:2",
        inputImages: [sourceImage("first"), sourceImage("second")],
      },
      "https://fal.run/google/nano-banana-2-lite/edit",
      {
        aspect_ratio: "3:2",
        image_urls: [
          `data:image/png;base64,${Buffer.from("first").toString("base64")}`,
          `data:image/png;base64,${Buffer.from("second").toString("base64")}`,
        ],
      },
    );
  });

  it("routes Grok Imagine edits through /edit with lowercase resolution", async () => {
    await generateFalImage("grok-edited.png", "grok-edited-data", {
      model: "xai/grok-imagine-image",
      prompt: "make it more realistic",
      aspectRatio: "16:9",
      resolution: "2K",
      inputImages: [{ buffer: Buffer.from("source"), mimeType: "image/jpeg" }],
    });

    expectFalJsonPost({
      url: "https://fal.run/xai/grok-imagine-image/edit",
      body: {
        prompt: "make it more realistic",
        aspect_ratio: "16:9",
        resolution: "2k",
        num_images: 1,
        output_format: "png",
        image_urls: [`data:image/jpeg;base64,${Buffer.from("source").toString("base64")}`],
      },
    });
  });

  it("preserves an explicit Grok Imagine /quality/edit model path", async () => {
    await expectImageRequest(
      {
        model: "xai/grok-imagine-image/quality/edit",
        inputImages: [{ buffer: Buffer.from("source"), mimeType: "image/png" }],
      },
      "https://fal.run/xai/grok-imagine-image/quality/edit",
      {
        image_urls: [`data:image/png;base64,${Buffer.from("source").toString("base64")}`],
      },
    );
  });

  it("combines resolution and aspect ratio for text generation", async () => {
    await expectImageRequest(
      {
        resolution: "2K",
        aspectRatio: "9:16",
      },
      "https://fal.run/fal-ai/flux/dev",
      {
        image_size: { width: 1152, height: 2048 },
      },
    );
  });

  it("uses Krea 2 native aspect-ratio and creativity payload schema", async () => {
    const result = await generateFalImage("krea.png", "krea-data", {
      model: "krea/v2/medium/text-to-image",
      prompt: "expressive risograph poster",
      aspectRatio: "9:16",
      providerOptions: {
        fal: {
          creativity: "high",
        },
      },
    });

    expectFalJsonPost({
      url: "https://fal.run/krea/v2/medium/text-to-image",
      body: {
        prompt: "expressive risograph poster",
        creativity: "high",
        aspect_ratio: "9:16",
      },
    });
    expect(result.model).toBe("krea/v2/medium/text-to-image");
  });

  it("passes reference images to Krea 2 as style references without edit suffix", async () => {
    await generateFalImage("krea-style.png", "krea-style-data", {
      model: "krea/v2/large/text-to-image",
      prompt: "portrait with the same palette and texture",
      size: "1024x1536",
      inputImages: [sourceImage("style-a"), sourceImage("style-b", "image/jpeg")],
    });

    expectFalJsonPost({
      url: "https://fal.run/krea/v2/large/text-to-image",
      body: {
        prompt: "portrait with the same palette and texture",
        creativity: "medium",
        aspect_ratio: "2:3",
        image_style_references: [
          { image_url: `data:image/png;base64,${Buffer.from("style-a").toString("base64")}` },
          { image_url: `data:image/jpeg;base64,${Buffer.from("style-b").toString("base64")}` },
        ],
      },
    });
  });

  it.each<{ name: string; request: Partial<ImageGenerationRequest>; error: string }>([
    {
      name: "GPT Image 2 edits above 10 reference images",
      request: {
        model: "openai/gpt-image-2",
        inputImages: Array.from({ length: 11 }, () => sourceImage("ref")),
      },
      error: "fal GPT Image edit supports at most 10 reference images",
    },
    {
      name: "resolution overrides for Nano Banana 2 Lite",
      request: {
        model: "google/nano-banana-2-lite",
        aspectRatio: "1:1",
        resolution: "2K",
        inputImages: [sourceImage("src")],
      },
      error: "fal Nano Banana 2 Lite does not support resolution overrides",
    },
    {
      name: "4K resolution for Grok Imagine edits",
      request: {
        model: "xai/grok-imagine-image",
        aspectRatio: "1:1",
        resolution: "4K",
        inputImages: [sourceImage("src")],
      },
      error: "fal Grok Imagine supports resolution values: 1K, 2K",
    },
    {
      name: "Nano Banana ratios for Grok Imagine",
      request: { model: "xai/grok-imagine-image", aspectRatio: "21:9" },
      error: "fal Grok Imagine supports aspectRatio values",
    },
    {
      name: "Krea 2 resolution hints instead of dropping them",
      request: { model: "krea/v2/medium/text-to-image", resolution: "1K" },
      error: "fal Krea 2 supports aspectRatio but not resolution overrides",
    },
    {
      name: "multi-image count for Krea 2 single-image endpoints",
      request: { model: "krea/v2/medium/text-to-image", count: 2 },
      error: "supports one output image per request",
    },
    {
      name: "output format overrides for Krea 2",
      request: { model: "krea/v2/medium/text-to-image", outputFormat: "jpeg" },
      error: "does not support outputFormat overrides",
    },
    {
      name: "multi-image for Flux edit",
      request: { inputImages: [sourceImage("one"), sourceImage("two")] },
      error: "at most one reference image",
    },
    {
      name: "aspect ratio for Flux edit",
      request: { aspectRatio: "16:9", inputImages: [sourceImage("one")] },
      error: "does not support aspectRatio overrides",
    },
  ])("rejects $name", async ({ request, error }) => {
    await expect(provider.generateImage({ ...defaultRequest, ...request })).rejects.toThrow(error);
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("does not auto-whitelist trusted private relay hosts from a configured baseUrl", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(
        releasedJson({ images: [{ url: "http://media.relay.internal/files/generated.png" }] }),
      )
      .mockResolvedValueOnce(releasedImage(Buffer.from("png-data")));

    await provider.generateImage({
      ...defaultRequest,
      cfg: {
        models: {
          providers: {
            fal: {
              baseUrl: "http://relay.internal:8080",
              models: [],
            },
          },
        },
      },
    });

    expectFalJsonPost({
      url: "http://relay.internal:8080/fal-ai/flux/dev",
      body: {
        prompt: "draw a cat",
        num_images: 1,
        output_format: "png",
      },
    });
    expectFalDownload({ call: 2, url: "http://media.relay.internal/files/generated.png" });
  });
});

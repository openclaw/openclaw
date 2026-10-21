import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildXaiImageGenerationProvider } from "./image-generation-provider.js";

type GenerateImageParams = Parameters<
  ReturnType<typeof buildXaiImageGenerationProvider>["generateImage"]
>[0];

const { auth, http } = vi.hoisted(() => ({
  auth: vi.fn(async (_params: { provider: string }) => ({ apiKey: "xai-key" })),
  http: {
    postJsonRequest:
      vi.fn<
        (params: ImageRequest) => Promise<{ response: Response; release: () => Promise<void> }>
      >(),
  },
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: auth,
}));

vi.mock("openclaw/plugin-sdk/provider-http", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-http")>(
    "openclaw/plugin-sdk/provider-http",
  );
  return { ...actual, ...http };
});

function generate(overrides: Partial<GenerateImageParams> = {}) {
  return buildXaiImageGenerationProvider().generateImage({
    provider: "xai",
    model: "grok-imagine-image",
    prompt: "Combine the references",
    cfg: {},
    ...overrides,
  });
}

function xaiConfig(overrides: { apiKey?: string; baseUrl?: string }) {
  return {
    models: { providers: { xai: { baseUrl: "https://api.x.ai/v1", models: [], ...overrides } } },
  };
}

function mockImage(mime_type?: string, b64_json = Buffer.from("testpng").toString("base64")) {
  http.postJsonRequest.mockResolvedValue({
    response: Response.json({ data: [{ b64_json, mime_type }] }),
    release: vi.fn(async () => {}),
  });
}

type ImageRequest = {
  url?: string;
  timeoutMs?: number;
  body?: Record<string, unknown>;
  headers?: Headers;
};

function requirePostJsonCall(index = 0): ImageRequest {
  const params = http.postJsonRequest.mock.calls[index]?.[0];
  if (!params) {
    throw new Error(`Expected postJsonRequest call ${index}`);
  }
  return params;
}

function inputImage(value: string, mimeType = "image/png") {
  return { buffer: Buffer.from(value), mimeType };
}

describe("xai image generation provider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockImage();
  });

  afterEach(() => {
    auth.mockClear();
    vi.unstubAllEnvs();
    http.postJsonRequest.mockReset();
    vi.useRealTimers();
  });

  it("builds provider with correct models, default, and capabilities", async () => {
    const provider = buildXaiImageGenerationProvider();
    expect(provider).toMatchObject({
      id: "xai",
      label: "xAI",
      defaultModel: "grok-imagine-image",
      models: ["grok-imagine-image", "grok-imagine-image-2.0", "grok-imagine-image-quality"],
      capabilities: {
        generate: { maxCount: 4, supportsAspectRatio: true },
        edit: { enabled: true, maxInputImages: 3 },
      },
    });
    expect(provider.capabilities.geometry?.aspectRatios).toEqual(
      "1:1 16:9 9:16 4:3 3:4 3:2 2:3 2:1 1:2 19.5:9 9:19.5 20:9 9:20".split(" "),
    );
    const isConfigured = provider.isConfiguredAsync;
    if (!isConfigured) {
      throw new Error("expected XAI image provider config predicate");
    }
    vi.stubEnv("XAI_API_KEY", undefined);
    expect(await isConfigured({})).toBe(false);
    expect(await isConfigured({ cfg: xaiConfig({ apiKey: "xai-image-test-key" }) })).toBe(true);
  });

  it.each([
    "grok-imagine-image",
    "grok-imagine-image-2.0",
    "grok-imagine-image-quality",
    "grok-imagine-image-future",
  ])("preserves explicit model %s in the generation request and result", async (model) => {
    const provider = buildXaiImageGenerationProvider();
    const result = await generate({
      model,
      prompt: "test prompt",
      aspectRatio: "20:9",
      resolution: "2K",
      cfg: xaiConfig({ baseUrl: "https://custom.x.ai/v1" }),
    });

    expect(auth.mock.calls[0]?.[0]).toMatchObject({ provider: "xai" });
    const request = requirePostJsonCall();
    expect(result.model).toBe(model);
    expect(provider.defaultTimeoutMs).toBe(600_000);
    expect(request).toMatchObject({
      url: "https://custom.x.ai/v1/images/generations",
      timeoutMs: 600_000,
      body: { model, aspect_ratio: "20:9", resolution: "2k" },
    });
  });

  it.each(["grok-imagine-image-2.0", "grok-imagine-image-quality"])(
    "sends %s edits as JSON with an image_url object",
    async (model) => {
      mockImage(
        "image/png",
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGD4z0ABAAEfAG0B0xMAAAAASUVORK5CYII=",
      );
      await generate({
        model,
        inputImages: [inputImage("fakeimage")],
      });

      const request = requirePostJsonCall();
      expect(request.url).toContain("/images/edits");
      expect(request.body).toMatchObject({
        model,
        prompt: "Combine the references",
        image: { url: expect.stringContaining("data:image/png;base64,"), type: "image_url" },
        response_format: "b64_json",
      });
    },
  );

  it("uses the plural xAI images payload for multiple edit inputs", async () => {
    mockImage("image/png", Buffer.from("edited").toString("base64"));
    await generate({
      inputImages: [
        inputImage("first"),
        inputImage("second", "image/jpeg"),
        inputImage("third", "image/webp"),
      ],
    });

    const request = requirePostJsonCall();
    expect(request.url).toContain("/images/edits");
    expect(request.body?.images).toEqual([
      { url: expect.stringContaining("data:image/png;base64,"), type: "image_url" },
      { url: expect.stringContaining("data:image/jpeg;base64,"), type: "image_url" },
      { url: expect.stringContaining("data:image/webp;base64,"), type: "image_url" },
    ]);
  });

  it("rejects more than three xAI edit references before HTTP", async () => {
    await expect(
      generate({
        inputImages: Array.from({ length: 4 }, (_, index) => inputImage(`reference-${index}`)),
      }),
    ).rejects.toThrow("xAI image editing supports up to 3 reference images");
    expect(http.postJsonRequest).not.toHaveBeenCalled();
  });
});

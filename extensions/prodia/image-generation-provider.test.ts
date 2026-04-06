import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProdiaImageGenerationProvider } from "./image-generation-provider.js";

const {
  resolveApiKeyForProviderMock,
  fetchWithTimeoutMock,
  assertOkOrThrowHttpErrorMock,
  resolveProviderHttpRequestConfigMock,
} = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "prodia-key" })),
  fetchWithTimeoutMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  resolveProviderHttpRequestConfigMock: vi.fn((params) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders),
    dispatcherPolicy: undefined,
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  fetchWithTimeout: fetchWithTimeoutMock,
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
}));

function makeImagePngResponse(): Response {
  const imageBytes = Buffer.from("fake-png-image-bytes");
  return new Response(imageBytes, {
    status: 200,
    headers: { "content-type": "image/png" },
  });
}

describe("prodia image generation provider", () => {
  afterEach(() => {
    resolveApiKeyForProviderMock.mockClear();
    fetchWithTimeoutMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
  });

  it("submits a text-to-image job and returns the image", async () => {
    fetchWithTimeoutMock.mockResolvedValue(makeImagePngResponse());

    const provider = buildProdiaImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "prodia",
      model: "flux-fast-schnell",
      prompt: "a friendly lobster in a top hat",
      cfg: {},
    });

    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(
      "https://inference.prodia.com/v2/job",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          type: "inference.flux-fast.schnell.txt2img.v2",
          config: { prompt: "a friendly lobster in a top hat" },
        }),
      }),
      120_000,
      fetch,
    );
    expect(result.images).toHaveLength(1);
    expect(result.images[0].mimeType).toBe("image/png");
    expect(result.model).toBe("flux-fast-schnell");
  });

  it("sends size dimensions in config", async () => {
    fetchWithTimeoutMock.mockResolvedValue(makeImagePngResponse());

    const provider = buildProdiaImageGenerationProvider();
    await provider.generateImage({
      provider: "prodia",
      model: "flux-dev",
      prompt: "landscape painting",
      cfg: {},
      size: "1024x768",
    });

    const callArgs = fetchWithTimeoutMock.mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string) as { config: Record<string, unknown> };
    expect(body.config.width).toBe(1024);
    expect(body.config.height).toBe(768);
  });

  it("submits an image-to-image job with multipart form data", async () => {
    fetchWithTimeoutMock.mockResolvedValue(makeImagePngResponse());

    const provider = buildProdiaImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "prodia",
      model: "flux-dev",
      prompt: "add a sunset background",
      cfg: {},
      inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
    });

    const callArgs = fetchWithTimeoutMock.mock.calls[0];
    expect(callArgs[1].body).toBeInstanceOf(FormData);
    expect(result.images).toHaveLength(1);
  });

  it("rejects unsupported text-to-image models", async () => {
    const provider = buildProdiaImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "prodia",
        model: "flux-ghibli",
        prompt: "a lobster in ghibli style",
        cfg: {},
      }),
    ).rejects.toThrow('Prodia text-to-image does not support model "flux-ghibli"');
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported image-to-image models", async () => {
    const provider = buildProdiaImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "prodia",
        model: "flux-fast-schnell",
        prompt: "edit this",
        cfg: {},
        inputImages: [{ buffer: Buffer.from("png"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow('Prodia image editing does not support model "flux-fast-schnell"');
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("parses multipart/form-data responses with job and output parts", async () => {
    const boundary = "----ProdiaBoundary";
    const jobJson = JSON.stringify({ id: "job-99", state: { current: "completed" } });
    const imageBytes = Buffer.from("fake-multipart-png");
    const body = [
      `------ProdiaBoundary\r\n`,
      `Content-Disposition: form-data; name="job"\r\n`,
      `Content-Type: application/json\r\n\r\n`,
      `${jobJson}\r\n`,
      `------ProdiaBoundary\r\n`,
      `Content-Disposition: form-data; name="output"\r\n`,
      `Content-Type: image/png\r\n\r\n`,
    ].join("");
    const bodyBuffer = Buffer.concat([
      Buffer.from(body),
      imageBytes,
      Buffer.from("\r\n------ProdiaBoundary--"),
    ]);

    fetchWithTimeoutMock.mockResolvedValue(
      new Response(bodyBuffer, {
        status: 200,
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      }),
    );

    const provider = buildProdiaImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "prodia",
      model: "flux-fast-schnell",
      prompt: "multipart test",
      cfg: {},
    });

    expect(result.images).toHaveLength(1);
    expect(result.images[0].buffer.toString()).toBe("fake-multipart-png");
    expect(result.metadata).toEqual(
      expect.objectContaining({ jobId: "job-99", state: "completed" }),
    );
  });

  it("throws when API key is missing", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({ apiKey: "" });
    const provider = buildProdiaImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "prodia",
        model: "flux-fast-schnell",
        prompt: "test",
        cfg: {},
      }),
    ).rejects.toThrow("Prodia API key missing");
  });
});

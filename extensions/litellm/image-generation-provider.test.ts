import type { ImageGenerationRequest } from "openclaw/plugin-sdk/image-generation";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLitellmImageGenerationProvider } from "./image-generation-provider.js";

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  postMultipartRequestMock,
  resolveProviderHttpRequestConfigMock,
} = getProviderHttpMocks();

installProviderHttpMockCleanup();

function pngResponse() {
  return {
    response: Response.json({
      data: [{ b64_json: Buffer.from("png-bytes").toString("base64") }],
    }),
    release: vi.fn(async () => {}),
  };
}

function generate(overrides: Partial<ImageGenerationRequest> = {}) {
  return buildLitellmImageGenerationProvider().generateImage({
    provider: "litellm",
    model: "gpt-image-2",
    prompt: "Draw a QA lighthouse",
    cfg: {},
    ...overrides,
  });
}

function generateAt(baseUrl: string, request?: { allowPrivateNetwork: boolean }) {
  postJsonRequestMock.mockImplementation(pngResponse);
  return generate({
    cfg: { models: { providers: { litellm: { baseUrl, request, models: [] } } } },
  });
}

function mockObjectArg(mock: unknown, index = -1): Record<string, unknown> {
  const calls = (mock as { mock?: { calls?: Array<Array<unknown>> } }).mock?.calls ?? [];
  const call = index < 0 ? calls.at(index) : calls[index];
  const [arg] = call ?? [];
  if (!arg || typeof arg !== "object") {
    throw new Error(`expected mock object argument ${index}`);
  }
  return arg as Record<string, unknown>;
}

describe("litellm image generation provider", () => {
  beforeEach(() => {
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "litellm-key" });
  });

  afterEach(() => {
    postMultipartRequestMock.mockReset();
  });

  it("defaults to the loopback proxy and allows private network for localhost", async () => {
    postJsonRequestMock.mockImplementation(pngResponse);

    await generate();

    expect(mockObjectArg(postJsonRequestMock)).toMatchObject({
      url: "http://localhost:4000/images/generations",
      allowPrivateNetwork: true,
    });
  });

  it("forwards count and size overrides on generation requests", async () => {
    postJsonRequestMock.mockImplementation(pngResponse);

    await generate({
      model: "dall-e-3",
      prompt: "two landscape variants",
      count: 2,
      size: "3840x2160",
    });

    expect(mockObjectArg(postJsonRequestMock).url).toBe("http://localhost:4000/images/generations");
    expect(mockObjectArg(postJsonRequestMock).body).toEqual({
      model: "dall-e-3",
      prompt: "two landscape variants",
      n: 2,
      size: "3840x2160",
    });
  });

  it("routes to the edit endpoint as multipart when input images are provided", async () => {
    postMultipartRequestMock.mockImplementation(pngResponse);

    await generate({
      prompt: "refine the hero",
      inputImages: [
        {
          buffer: Buffer.from("fake-input"),
          mimeType: "image/png",
        },
      ],
    });

    // LiteLLM rejects JSON edits before they reach the upstream provider.
    expect(postJsonRequestMock).not.toHaveBeenCalled();
    expect(mockObjectArg(postMultipartRequestMock).url).toBe("http://localhost:4000/images/edits");

    const form = mockObjectArg(postMultipartRequestMock).body as FormData;
    expect(form.get("model")).toBe("gpt-image-2");
    expect(form.get("prompt")).toBe("refine the hero");
    expect(form.getAll("image")).toHaveLength(1);
    expect(form.getAll("image[]")).toHaveLength(0);
    expect(form.get("image")).toBeInstanceOf(Blob);
  });

  it("omits n on single-image edits so LiteLLM defaults it to 1", async () => {
    postMultipartRequestMock.mockImplementation(pngResponse);

    await generate({
      prompt: "refine the hero",
      inputImages: [
        {
          buffer: Buffer.from("fake-input"),
          mimeType: "image/png",
        },
      ],
    });

    const form = mockObjectArg(postMultipartRequestMock).body as FormData;
    // Some backends (e.g. Gemini image models) reject an explicit n=1 on
    // /v1/images/edits; the default count must not send n.
    expect(form.has("n")).toBe(false);
  });

  it("sends n only for multi-image edits", async () => {
    postMultipartRequestMock.mockImplementation(pngResponse);

    await generate({
      prompt: "two variants of the hero",
      count: 2,
      inputImages: [
        {
          buffer: Buffer.from("fake-input"),
          mimeType: "image/png",
        },
      ],
    });

    const form = mockObjectArg(postMultipartRequestMock).body as FormData;
    expect(form.get("n")).toBe("2");
  });

  it("omits n on single-image generation requests", async () => {
    postJsonRequestMock.mockImplementation(pngResponse);

    await generate({
      model: "gpt-image-2",
      prompt: "a single cube",
    });

    const body = mockObjectArg(postJsonRequestMock).body as Record<string, unknown>;
    expect(body.n).toBeUndefined();
    expect(body).toEqual({
      model: "gpt-image-2",
      prompt: "a single cube",
      size: "1024x1024",
    });
  });

  it("sends multiple reference images as repeated image[] parts", async () => {
    postMultipartRequestMock.mockImplementation(pngResponse);

    await generate({
      prompt: "merge these",
      inputImages: [
        { buffer: Buffer.from("first"), mimeType: "image/png" },
        { buffer: Buffer.from("second"), mimeType: "image/jpeg" },
      ],
    });

    const form = mockObjectArg(postMultipartRequestMock).body as FormData;
    // Sending both part names is an error.
    expect(form.getAll("image")).toHaveLength(0);
    const images = form.getAll("image[]");
    expect(
      await Promise.all(
        images.map(async (image) => {
          assert(image instanceof Blob);
          return { bytes: Buffer.from(await image.arrayBuffer()), mimeType: image.type };
        }),
      ),
    ).toEqual([
      { bytes: Buffer.from("first"), mimeType: "image/png" },
      { bytes: Buffer.from("second"), mimeType: "image/jpeg" },
    ]);
  });

  it("throws a clear error when the API key is missing", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({ apiKey: "" });

    await expect(generate()).rejects.toThrow("LiteLLM API key missing");
  });

  it("auto-allows private network for loopback-style baseUrls", async () => {
    const cases = [
      "http://127.255.255.254:4000",
      "http://[::1]:4000",
      "http://[0:0:0:0:0:0:0:1]:4000",
      "http://host.docker.internal:4000",
      "https://localhost:4000",
      "https://LOCALHOST:4000",
      "http://proxy.localhost:4000",
    ] as const;
    for (const baseUrl of cases) {
      await generateAt(baseUrl);
      expect(
        mockObjectArg(resolveProviderHttpRequestConfigMock),
        `expected allowPrivateNetwork=true for ${baseUrl}`,
      ).toHaveProperty("allowPrivateNetwork", true);
    }
  });

  it("requires explicit private-network opt-in for LAN and internal baseUrls", async () => {
    const cases = [
      "http://192.168.5.10:4000",
      "http://printer.local:4000",
      "http://127.evil.com:4000",
      "http://[::ffff:127.0.0.1]:4000",
    ] as const;
    for (const baseUrl of cases) {
      await generateAt(baseUrl);
      expect(
        mockObjectArg(resolveProviderHttpRequestConfigMock),
        `expected no automatic allowPrivateNetwork for ${baseUrl}`,
      ).toHaveProperty("allowPrivateNetwork", undefined);
      expect(mockObjectArg(postJsonRequestMock).allowPrivateNetwork).toBe(false);
    }
  });

  it("honors explicit private-network opt-in for a non-loopback hostname", async () => {
    await generateAt("http://127.evil.com:4000", { allowPrivateNetwork: true });

    const config = mockObjectArg(resolveProviderHttpRequestConfigMock);
    expect(config.allowPrivateNetwork).toBeUndefined();
    expect(config.request).toEqual({ allowPrivateNetwork: true });
    expect(mockObjectArg(postJsonRequestMock).allowPrivateNetwork).toBe(true);
  });

  it("does not allow private network for public hosts that embed private strings in the URL", async () => {
    // Only the parsed hostname can grant the loopback exemption.
    const cases = [
      "https://evil.example.com/?target=host.docker.internal",
      "https://evil.example.com/host.docker.internal/foo",
      "https://public-api.openai.com/v1",
    ] as const;
    for (const baseUrl of cases) {
      await generateAt(baseUrl);
      expect(
        mockObjectArg(resolveProviderHttpRequestConfigMock),
        `expected allowPrivateNetwork=false for ${baseUrl}`,
      ).toHaveProperty("allowPrivateNetwork", undefined);
    }
  });
});

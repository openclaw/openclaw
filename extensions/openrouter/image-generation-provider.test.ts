import { resolveProviderHttpRequestConfigWithOriginTrust } from "openclaw/plugin-sdk/provider-http";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  requireFirstPostJsonRecordRequest,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenRouterImageGenerationProvider } from "./image-generation-provider.js";

const { postJsonRequestMock, resolveApiKeyForProviderMock, resolveProviderHttpRequestConfigMock } =
  getProviderHttpMocks();

installProviderHttpMockCleanup();

const postRequest = () => requireFirstPostJsonRecordRequest(postJsonRequestMock, "image request");

function requireHeaders(value: unknown): Headers {
  if (!(value instanceof Headers)) {
    throw new Error("expected OpenRouter image request headers");
  }
  return value;
}

function customConfig(request?: ModelProviderConfig["request"]) {
  const openrouter = {
    baseUrl: "https://custom.openrouter.test/api/v1",
    models: [],
    ...(request ? { request } : {}),
  };
  return { models: { providers: { openrouter } } };
}

type ImageRequest = Parameters<
  ReturnType<typeof buildOpenRouterImageGenerationProvider>["generateImage"]
>[0];
function generateImage(overrides: Partial<ImageRequest> = {}) {
  return buildOpenRouterImageGenerationProvider().generateImage({
    provider: "openrouter",
    model: "google/gemini-3.1-flash-image-preview",
    prompt: "draw a sticker",
    cfg: {},
    ...overrides,
  });
}

function respond(body: unknown) {
  const response = jsonResponse(body);
  postJsonRequestMock.mockResolvedValue(response);
  return response.release;
}

function jsonResponse(body: unknown) {
  return { response: Response.json(body), release: vi.fn(async () => {}) };
}

function respondWithChat(message: Record<string, unknown>) {
  return respond({ choices: [{ message }] });
}

describe("openrouter image generation provider", () => {
  beforeEach(() => {
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "openrouter-key" });
  });

  it("preserves chat-completion image requests for configured custom bases", async () => {
    const release = respondWithChat({
      images: [{ imageUrl: { url: "data:image/png;base64,cG5nLW9uZQ==" } }],
    });
    const result = await generateImage({
      aspectRatio: "16:9",
      resolution: "2K",
      count: 2,
      timeoutMs: 12_345,
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      cfg: customConfig(),
    });

    const request = postRequest();
    const headers = requireHeaders(request.headers);
    expect(Object.fromEntries(headers.entries())).toEqual({
      authorization: "Bearer openrouter-key",
    });
    expect(request).toEqual({
      url: "https://custom.openrouter.test/api/v1/chat/completions",
      headers,
      body: {
        model: "google/gemini-3.1-flash-image-preview",
        messages: [{ role: "user", content: "draw a sticker" }],
        modalities: ["image", "text"],
        n: 2,
        image_config: { aspect_ratio: "16:9", image_size: "2K" },
      },
      timeoutMs: 12_345,
      fetchFn: fetch,
      allowPrivateNetwork: false,
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      dispatcherPolicy: undefined,
    });
    expect(result.images[0]).toMatchObject({
      buffer: Buffer.from("png-one"),
      mimeType: "image/png",
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("applies configured image request transport without weakening private-network policy", async () => {
    const requestPolicy = {
      allowPrivateNetwork: true,
      headers: { "X-OpenRouter-Trace": "image-trace" },
      auth: { mode: "authorization-bearer" as const, token: "override-image-token" },
      proxy: { mode: "explicit-proxy" as const, url: "http://proxy.example.test:8443" },
      tls: { ca: "synthetic-provider-ca", serverName: "provider.example.test" },
    };
    const dispatcherPolicy = { mode: "explicit-proxy" as const, proxyUrl: requestPolicy.proxy.url };
    resolveProviderHttpRequestConfigMock.mockImplementationOnce((params) => {
      const result = resolveProviderHttpRequestConfigWithOriginTrust(params);
      return { ...result, dispatcherPolicy: result.dispatcherPolicy };
    });
    const release = respondWithChat({
      images: [{ image_url: { url: "data:image/png;base64,cG5n" } }],
    });

    const result = await generateImage({ cfg: customConfig(requestPolicy) });

    const request = postRequest();
    const headers = requireHeaders(request.headers);
    expect(headers.get("authorization")).toBe("Bearer override-image-token");
    expect(headers.get("x-openrouter-trace")).toBe("image-trace");
    expect(request).toMatchObject({
      url: "https://custom.openrouter.test/api/v1/chat/completions",
      allowPrivateNetwork: false,
      dispatcherPolicy,
    });
    expect(result.images[0]?.buffer).toEqual(Buffer.from("png"));
    expect(release).toHaveBeenCalledOnce();
  });

  it("sends canonical reference images as input_references", async () => {
    respond({ data: [{ b64_json: "d2VicC1vbmU=", media_type: "image/webp" }] });

    const result = await generateImage({
      inputImages: [{ buffer: Buffer.from("source-image"), mimeType: "image/png" }],
      aspectRatio: "16:9",
      resolution: "2K",
    });

    const request = postRequest();
    expect(request.url).toBe("https://openrouter.ai/api/v1/images");
    expect(request.body).toMatchObject({ aspect_ratio: "16:9", resolution: "2K" });
    expect((request.body as Record<string, unknown>).input_references).toEqual([
      {
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${Buffer.from("source-image").toString("base64")}`,
        },
      },
    ]);
    expect(result.images[0]).toMatchObject({
      buffer: Buffer.from("webp-one"),
      mimeType: "image/webp",
    });
  });

  it("fans out canonical batches into bounded single-image requests", async () => {
    const model = "openai/gpt-5.4-image-2";
    postJsonRequestMock
      .mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: "cG5nLW9uZQ==" }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: "cG5nLXR3bw==" }] }));

    const result = await generateImage({ model, prompt: "draw two stickers", count: 2 });

    expect(postJsonRequestMock.mock.calls).toEqual(
      Array.from({ length: 2 }, () => [
        expect.objectContaining({
          url: "https://openrouter.ai/api/v1/images",
          body: { model, prompt: "draw two stickers", n: 1 },
        }),
      ]),
    );
    expect(result.images.map((image) => image.buffer.toString())).toEqual(["png-one", "png-two"]);
  });

  it("fails a canonical batch when any request fails", async () => {
    postJsonRequestMock
      .mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: "cG5nLW9uZQ==" }] }))
      .mockRejectedValueOnce(new Error("upstream capacity"));

    await expect(generateImage({ prompt: "draw two stickers", count: 2 })).rejects.toThrow(
      "upstream capacity",
    );
  });

  it("wraps wrong-shape successful dedicated image responses", async () => {
    respond({ data: { b64_json: "bad-shape" } });

    await expect(generateImage()).rejects.toThrow("OpenRouter image generation response malformed");
  });

  it("extracts image fallbacks from string content and raw b64 parts", async () => {
    const png = Buffer.from("png-inline").toString("base64");
    const raw = Buffer.from("raw-inline").toString("base64");
    respond({
      choices: [
        { message: { content: `done data:image/png;base64,${png}` } },
        { message: { content: [{ b64_json: raw }] } },
        { message: { content: [{ inlineData: { data: raw, mimeType: "image/webp" } }] } },
        { message: { content: [{ inline_data: { data: raw, mime_type: "image/jpeg" } }] } },
      ],
    });

    const result = await generateImage({ cfg: customConfig() });

    expect(result.images.map((image) => [image.buffer.toString(), image.mimeType])).toEqual([
      ["png-inline", "image/png"],
      ["raw-inline", "image/png"],
      ["raw-inline", "image/webp"],
      ["raw-inline", "image/jpeg"],
    ]);
  });

  it("rejects invalid raw image parts in strict extraction mode", async () => {
    respondWithChat({ content: [{ b64_json: "not-base64!" }] });

    await expect(generateImage({ cfg: customConfig() })).rejects.toThrow(
      "OpenRouter image generation response malformed",
    );
  });
});

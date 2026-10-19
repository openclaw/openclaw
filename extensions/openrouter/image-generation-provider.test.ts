import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenRouterImageGenerationProvider } from "./image-generation-provider.js";

const { postJsonRequestMock, resolveApiKeyForProviderMock, resolveProviderHttpRequestConfigMock } =
  getProviderHttpMocks();

installProviderHttpMockCleanup();

function postRequest(): Record<string, unknown> {
  const request = postJsonRequestMock.mock.calls[0]?.[0];
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("expected OpenRouter image generation request");
  }
  return request as Record<string, unknown>;
}

function configRequest(): Record<string, unknown> {
  const request = resolveProviderHttpRequestConfigMock.mock.calls[0]?.[0];
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("expected OpenRouter image config request");
  }
  return request;
}

function requireHeaders(value: unknown): Headers {
  if (!(value instanceof Headers)) {
    throw new Error("expected OpenRouter image request headers");
  }
  return value;
}

function customConfig(request?: ModelProviderConfig["request"]) {
  return {
    models: {
      providers: {
        openrouter: {
          baseUrl: "https://custom.openrouter.test/api/v1",
          models: [],
          ...(request ? { request } : {}),
        },
      },
    },
  };
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

function jsonResponse(body: unknown, release = vi.fn(async () => {})) {
  return { response: Response.json(body), release };
}

function chatResponse(message: Record<string, unknown>, release = vi.fn(async () => {})) {
  return jsonResponse({ choices: [{ message }] }, release);
}

describe("openrouter image generation provider", () => {
  beforeEach(() => {
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "openrouter-key" });
  });

  it("preserves chat-completion image requests for configured custom bases", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockImplementation(async () =>
      chatResponse(
        { images: [{ imageUrl: { url: "data:image/png;base64,cG5nLW9uZQ==" } }] },
        release,
      ),
    );
    const result = await generateImage({
      aspectRatio: "16:9",
      resolution: "2K",
      count: 2,
      timeoutMs: 12_345,
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      cfg: customConfig(),
    });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledOnce();
    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith({
      provider: "openrouter",
      cfg: customConfig(),
      agentDir: undefined,
      store: undefined,
    });
    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledOnce();
    expect(configRequest()).toEqual({
      baseUrl: "https://custom.openrouter.test/api/v1",
      defaultBaseUrl: "https://openrouter.ai/api/v1",
      allowPrivateNetwork: false,
      defaultHeaders: {
        Authorization: "Bearer openrouter-key",
      },
      request: undefined,
      provider: "openrouter",
      capability: "image",
      transport: "http",
    });
    expect(postJsonRequestMock).toHaveBeenCalledOnce();
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
        image_config: {
          aspect_ratio: "16:9",
          image_size: "2K",
        },
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
    const dispatcherPolicy = {
      mode: "explicit-proxy" as const,
      proxyUrl: requestPolicy.proxy.url,
    };
    resolveProviderHttpRequestConfigMock.mockImplementationOnce((params) => {
      const headers = new Headers(params.defaultHeaders);
      for (const [name, value] of Object.entries(params.request?.headers ?? {})) {
        headers.set(name, value);
      }
      if (params.request?.auth?.mode === "authorization-bearer") {
        headers.set("Authorization", `Bearer ${params.request.auth.token}`);
      }
      return {
        baseUrl: params.baseUrl ?? params.defaultBaseUrl,
        allowPrivateNetwork:
          (params.allowPrivateNetwork ?? params.request?.allowPrivateNetwork) === true,
        headers,
        dispatcherPolicy,
      };
    });
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockImplementation(async () =>
      chatResponse({ images: [{ image_url: { url: "data:image/png;base64,cG5n" } }] }, release),
    );

    const result = await generateImage({
      cfg: customConfig(requestPolicy),
    });

    expect(configRequest()).toMatchObject({
      baseUrl: "https://custom.openrouter.test/api/v1",
      provider: "openrouter",
      capability: "image",
      allowPrivateNetwork: false,
      request: requestPolicy,
    });
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
    postJsonRequestMock.mockImplementation(async () =>
      jsonResponse({
        data: [{ b64_json: Buffer.from("webp-one").toString("base64"), media_type: "image/webp" }],
      }),
    );

    const result = await generateImage({
      inputImages: [{ buffer: Buffer.from("source-image"), mimeType: "image/png" }],
    });

    const request = postRequest();
    expect(request.url).toBe("https://openrouter.ai/api/v1/images");
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

  it.each(["openai/gpt-5.4-image-2"])(
    "fans out canonical %s batches into bounded single-image requests",
    async (model) => {
      postJsonRequestMock
        .mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: "cG5nLW9uZQ==" }] }))
        .mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: "cG5nLXR3bw==" }] }));

      const result = await generateImage({
        model,
        prompt: "draw two stickers",
        count: 2,
      });

      expect(postJsonRequestMock).toHaveBeenCalledTimes(2);
      expect(
        postJsonRequestMock.mock.calls.map(([request]) => ({
          url: Reflect.get(request as object, "url"),
          body: Reflect.get(request as object, "body"),
        })),
      ).toEqual(
        Array.from({ length: 2 }, () => ({
          url: "https://openrouter.ai/api/v1/images",
          body: { model, prompt: "draw two stickers", n: 1 },
        })),
      );
      expect(result.images.map((image) => image.buffer.toString())).toEqual(["png-one", "png-two"]);
    },
  );

  it("fails a canonical batch when any request fails", async () => {
    postJsonRequestMock
      .mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: "cG5nLW9uZQ==" }] }))
      .mockRejectedValueOnce(new Error("upstream capacity"));

    await expect(
      generateImage({
        prompt: "draw two stickers",
        count: 2,
      }),
    ).rejects.toThrow("upstream capacity");
  });

  it("wraps wrong-shape successful dedicated image responses", async () => {
    postJsonRequestMock.mockImplementation(async () =>
      jsonResponse({ data: { b64_json: "bad-shape" } }),
    );

    await expect(generateImage()).rejects.toThrow("OpenRouter image generation response malformed");
  });

  it("extracts image fallbacks from string content and raw b64 parts", async () => {
    const png = Buffer.from("png-inline").toString("base64");
    const raw = Buffer.from("raw-inline").toString("base64");
    postJsonRequestMock.mockImplementation(async () =>
      jsonResponse({
        choices: [
          { message: { content: `done data:image/png;base64,${png}` } },
          { message: { content: [{ b64_json: raw }] } },
        ],
      }),
    );

    const result = await generateImage({
      cfg: customConfig(),
    });

    expect(result.images.map((image) => image.buffer.toString())).toEqual([
      "png-inline",
      "raw-inline",
    ]);
  });

  it("rejects invalid raw image parts in strict extraction mode", async () => {
    postJsonRequestMock.mockImplementation(async () =>
      chatResponse({ content: [{ b64_json: "not-base64!" }] }),
    );

    await expect(
      generateImage({
        cfg: customConfig(),
      }),
    ).rejects.toThrow("OpenRouter image generation response malformed");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

const {
  postJsonRequestMock,
  resolveProviderHttpRequestConfigMock,
  assertOkOrThrowHttpErrorMock,
  resolveApiKeyForProviderMock,
} = vi.hoisted(() => ({
  postJsonRequestMock: vi.fn(),
  resolveProviderHttpRequestConfigMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(),
  resolveApiKeyForProviderMock: vi.fn(),
}));

describe("Google image-generation provider proxy handling", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.doUnmock("openclaw/plugin-sdk/provider-http");
    vi.doUnmock("openclaw/plugin-sdk/provider-auth-runtime");
    vi.resetModules();
  });

  it("passes pinDns=false through the Google image generation request path", async () => {
    vi.doMock("openclaw/plugin-sdk/provider-http", () => ({
      assertOkOrThrowHttpError: (...args: unknown[]) => assertOkOrThrowHttpErrorMock(...args),
      postJsonRequest: (...args: unknown[]) => postJsonRequestMock(...args),
      resolveProviderHttpRequestConfig: (...args: unknown[]) =>
        resolveProviderHttpRequestConfigMock(...args),
    }));
    vi.doMock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
      resolveApiKeyForProvider: (...args: unknown[]) => resolveApiKeyForProviderMock(...args),
    }));
    resolveApiKeyForProviderMock.mockResolvedValue({
      apiKey: "google-test-key",
      source: "env",
      mode: "api-key",
    });
    resolveProviderHttpRequestConfigMock.mockReturnValue({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      allowPrivateNetwork: false,
      headers: new Headers({ "x-goog-api-key": "google-test-key" }),
      dispatcherPolicy: { mode: "env-proxy" },
    });
    postJsonRequestMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: "image/png",
                      data: Buffer.from("proxy-safe-image").toString("base64"),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
      release: vi.fn(async () => {}),
    });

    const { buildGoogleImageGenerationProvider } = await import("./image-generation-provider.js");
    const provider = buildGoogleImageGenerationProvider();

    await provider.generateImage({
      provider: "google",
      model: "gemini-3.1-flash-image-preview",
      prompt: "draw a cat behind a proxy",
      cfg: {},
    });

    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent",
        fetchFn: fetch,
        pinDns: false,
        dispatcherPolicy: { mode: "env-proxy" },
      }),
    );
  });
});

// Openrouter tests cover speech provider plugin behavior.
import { requireFirstPostJsonRecordRequest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenRouterSpeechProvider } from "./speech-provider.js";

const { assertOkOrThrowHttpErrorMock, postJsonRequestMock, resolveProviderHttpRequestConfigMock } =
  vi.hoisted(() => ({
    assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
    postJsonRequestMock: vi.fn(),
    resolveProviderHttpRequestConfigMock: vi.fn((params: Record<string, unknown>) => ({
      baseUrl: params.baseUrl ?? params.defaultBaseUrl ?? "https://openrouter.ai/api/v1",
      allowPrivateNetwork: false,
      headers: new Headers(params.defaultHeaders as HeadersInit | undefined),
      dispatcherPolicy: undefined,
    })),
  }));

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  postJsonRequest: postJsonRequestMock,
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
}));

function requireHeaders(value: unknown): Headers {
  if (!(value instanceof Headers)) {
    throw new Error("expected OpenRouter speech request headers");
  }
  return value;
}

describe("openrouter speech provider", () => {
  afterEach(() => {
    assertOkOrThrowHttpErrorMock.mockClear();
    postJsonRequestMock.mockReset();
    resolveProviderHttpRequestConfigMock.mockClear();
    vi.unstubAllEnvs();
  });

  it("never sends a custom model-provider credential to the public speech endpoint", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: new Response(new Uint8Array([1]), { status: 200 }),
      release: vi.fn(async () => {}),
    });

    await buildOpenRouterSpeechProvider().synthesize({
      text: "private proxy speech",
      cfg: {
        models: {
          providers: {
            openrouter: {
              apiKey: "synthetic-private-proxy-key",
              baseUrl: "https://private.example.invalid/router/v1///",
            },
          },
        },
      } as never,
      providerConfig: {},
      target: "voice-note",
      timeoutMs: 5000,
    });

    const request = requireFirstPostJsonRecordRequest(
      postJsonRequestMock,
      "OpenRouter speech request",
    );
    expect(request.url).toBe("https://private.example.invalid/router/v1/audio/speech");
    expect(requireHeaders(request.headers).get("authorization")).toBe(
      "Bearer synthetic-private-proxy-key",
    );
  });

  it("preserves a speech-specific custom destination over the model-provider base URL", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: new Response(new Uint8Array([1]), { status: 200 }),
      release: vi.fn(async () => {}),
    });

    await buildOpenRouterSpeechProvider().synthesize({
      text: "speech-specific private proxy",
      cfg: {
        models: {
          providers: {
            openrouter: {
              apiKey: "synthetic-private-proxy-key",
              baseUrl: "https://model-proxy.example.invalid/v1",
            },
          },
        },
      } as never,
      providerConfig: { baseUrl: "https://speech-proxy.example.invalid/router/v1///" },
      target: "voice-note",
      timeoutMs: 5000,
    });

    const request = requireFirstPostJsonRecordRequest(
      postJsonRequestMock,
      "OpenRouter speech request",
    );
    expect(request.url).toBe("https://speech-proxy.example.invalid/router/v1/audio/speech");
    expect(requireHeaders(request.headers).get("authorization")).toBe(
      "Bearer synthetic-private-proxy-key",
    );
  });

  it("does not synthesize when a configured private destination has no credential", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");

    await expect(
      buildOpenRouterSpeechProvider().synthesize({
        text: "missing private key",
        cfg: {
          models: {
            providers: {
              openrouter: { baseUrl: "https://private.example.invalid/v1" },
            },
          },
        } as never,
        providerConfig: {},
        target: "voice-note",
        timeoutMs: 5000,
      }),
    ).rejects.toThrow("OpenRouter API key missing");
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("uses OPENROUTER_API_KEY when provider config omits apiKey", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-env");
    const provider = buildOpenRouterSpeechProvider();

    expect(
      provider.isConfigured({
        cfg: {} as never,
        providerConfig: {},
        timeoutMs: 30_000,
      }),
    ).toBe(true);
  });
});

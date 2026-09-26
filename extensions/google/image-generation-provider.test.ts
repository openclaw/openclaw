// Google tests cover image generation provider plugin behavior.
import type { ImageGenerationRequest } from "openclaw/plugin-sdk/image-generation";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth";
import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import * as providerHttp from "openclaw/plugin-sdk/provider-http";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGoogleImageGenerationProvider } from "./image-generation-provider.js";

function generateImage(overrides: Partial<ImageGenerationRequest> = {}) {
  return buildGoogleImageGenerationProvider().generateImage({
    provider: "google",
    model: "gemini-3.1-flash-image",
    prompt: "draw a cat",
    cfg: {},
    ...overrides,
  });
}

function googleImageConfig(provider: Omit<ModelProviderConfig, "models">) {
  return { models: { providers: { google: { ...provider, models: [] } } } };
}

function googleImagePayload(parts: unknown[]) {
  return { candidates: [{ content: { parts } }] };
}

let ssrfMock: { mockRestore: () => void } | undefined;

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockGoogleApiKeyAuth() {
  vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
    apiKey: "google-test-key",
    source: "env",
    mode: "api-key",
  });
}

function installGoogleFetchMock() {
  const fetchMock = vi.fn().mockResolvedValue(
    jsonResponse(
      googleImagePayload([
        {
          inlineData: {
            mimeType: "image/png",
            data: Buffer.from("png-data").toString("base64"),
          },
        },
      ]),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function fetchRequest(fetchMock: ReturnType<typeof vi.fn>): {
  body?: string;
  headers?: HeadersInit;
  method?: string;
  url: string;
} {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
  expect(typeof url).toBe("string");
  if (!init) {
    throw new Error("Expected fetch init");
  }
  return {
    body: typeof init.body === "string" ? init.body : undefined,
    headers: init.headers,
    method: init.method,
    url,
  };
}

function postJsonRequestOptions(spy: unknown): {
  allowPrivateNetwork?: boolean;
  pinDns?: boolean;
  ssrfPolicy?: { allowRfc2544BenchmarkRange?: boolean };
} {
  const options = (spy as { mock?: { calls?: Array<[unknown]> } }).mock?.calls?.[0]?.[0];
  if (!options) {
    throw new Error("Expected postJsonRequest options");
  }
  return options as {
    allowPrivateNetwork?: boolean;
    pinDns?: boolean;
    ssrfPolicy?: { allowRfc2544BenchmarkRange?: boolean };
  };
}

describe("Google image-generation provider", () => {
  beforeEach(() => {
    ssrfMock = mockPinnedHostnameResolution();
  });

  afterEach(() => {
    ssrfMock?.mockRestore();
    ssrfMock = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("generates image buffers from the Gemini generateContent API", async () => {
    mockGoogleApiKeyAuth();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        googleImagePayload([
          { text: "generated" },
          {
            inlineData: {
              mimeType: "image/png",
              data: Buffer.from("png-data").toString("base64"),
            },
          },
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateImage({ size: "1536x1024" });

    const request = fetchRequest(fetchMock);
    expect(request.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent",
    );
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.body ?? "")).toEqual({
      contents: [
        {
          role: "user",
          parts: [{ text: "draw a cat" }],
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: {
          aspectRatio: "3:2",
          imageSize: "2K",
        },
      },
    });
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("png-data"),
          mimeType: "image/png",
          fileName: "image-1.png",
        },
      ],
      model: "gemini-3.1-flash-image",
    });
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", "   "],
  ])(
    "uses the default Gemini API root when the configured base URL is %s",
    async (_label, baseUrl) => {
      mockGoogleApiKeyAuth();
      const fetchMock = installGoogleFetchMock();

      await generateImage({ cfg: googleImageConfig({ baseUrl }) });

      const request = fetchRequest(fetchMock);
      expect(request.url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent",
      );
      expect(new Headers(request.headers).get("x-goog-api-client")).toMatch(/^openclaw\//u);
    },
  );

  it("passes request SSRF policy to the provider HTTP helper", async () => {
    mockGoogleApiKeyAuth();
    const postJsonRequest = vi.spyOn(providerHttp, "postJsonRequest").mockResolvedValue({
      response: Response.json(
        googleImagePayload([
          {
            inlineData: {
              mimeType: "image/png",
              data: Buffer.from("png-data").toString("base64"),
            },
          },
        ]),
      ),
      finalUrl:
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent",
      release: async () => {},
    });

    await generateImage({ ssrfPolicy: { allowRfc2544BenchmarkRange: true } });

    expect(postJsonRequestOptions(postJsonRequest).ssrfPolicy).toEqual({
      allowRfc2544BenchmarkRange: true,
    });
  });

  it("wraps wrong-shape successful Gemini image responses", async () => {
    mockGoogleApiKeyAuth();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ candidates: { content: { parts: [] } } })),
    );

    await expect(generateImage({})).rejects.toThrow("Google image generation response malformed");
  });

  it("rejects invalid inline image data in successful Gemini responses", async () => {
    mockGoogleApiKeyAuth();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            googleImagePayload([{ inlineData: { mimeType: "image/png", data: "not-base64!" } }]),
          ),
        ),
    );

    await expect(generateImage({})).rejects.toThrow("Google image generation response malformed");
  });

  it("accepts URL-safe base64 image bytes", async () => {
    mockGoogleApiKeyAuth();
    const imageBytes = Buffer.from([0xfb, 0xff, 0x50, 0x4e, 0x47]);
    const imageBase64url = imageBytes.toString("base64url");
    expect(imageBase64url).toMatch(/[-_]/);
    expect(imageBase64url).not.toMatch(/[+/]/);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          googleImagePayload([
            {
              inlineData: {
                mimeType: "image/png",
                data: imageBase64url,
              },
            },
          ]),
        ),
      ),
    );

    const result = await generateImage({});

    expect(result.images[0]?.buffer).toEqual(imageBytes);
  });

  it("rejects mixed-alphabet inline image data", async () => {
    mockGoogleApiKeyAuth();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            googleImagePayload([{ inlineData: { mimeType: "image/png", data: "aGVsbG8+_" } }]),
          ),
        ),
    );

    await expect(generateImage({})).rejects.toThrow("Google image generation response malformed");
  });

  it("accepts OAuth JSON auth and inline_data responses", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: JSON.stringify({ token: "oauth-token" }),
      source: "profile",
      mode: "token",
    });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        googleImagePayload([
          {
            inline_data: {
              mime_type: "image/jpeg",
              data: Buffer.from("jpg-data").toString("base64"),
            },
          },
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateImage({ prompt: "draw a dog" });

    const request = fetchRequest(fetchMock);
    expect(request.url.length).toBeGreaterThan(0);
    expect(request.headers).toBeInstanceOf(Headers);
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer oauth-token");
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("jpg-data"),
          mimeType: "image/jpeg",
          fileName: "image-1.jpg",
        },
      ],
      model: "gemini-3.1-flash-image",
    });
  });

  it("accepts valid multi-image inline JSON responses above the generic provider JSON cap", async () => {
    mockGoogleApiKeyAuth();
    const imageBytes = Buffer.alloc(4 * 1024 * 1024, 1);
    const imagePayload = imageBytes.toString("base64");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          googleImagePayload(
            Array.from({ length: 3 }, () => ({
              inlineData: {
                mimeType: "image/png",
                data: imagePayload,
              },
            })),
          ),
        ),
      ),
    );

    const result = await generateImage({});

    expect(result.images).toHaveLength(3);
    expect(result.images.map((image) => image.buffer.byteLength)).toEqual([
      imageBytes.byteLength,
      imageBytes.byteLength,
      imageBytes.byteLength,
    ]);
  });

  it("still rejects oversized Google image JSON responses", async () => {
    mockGoogleApiKeyAuth();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(googleImagePayload([{ text: "x".repeat(35 * 1024 * 1024) }])),
        ),
    );

    await expect(generateImage({})).rejects.toThrow(
      "google.image-generation: JSON response exceeds",
    );
  });

  it("sends reference images and explicit resolution for edit flows", async () => {
    mockGoogleApiKeyAuth();
    const fetchMock = installGoogleFetchMock();

    await generateImage({
      model: "gemini-3-pro-image",
      prompt: "Change only the sky to a sunset.",
      resolution: "4K",
      inputImages: [
        {
          buffer: Buffer.from("reference-bytes"),
          mimeType: "image/png",
          fileName: "reference.png",
        },
      ],
    });

    const request = fetchRequest(fetchMock);
    expect(request.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent",
    );
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.body ?? "")).toEqual({
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: "image/png",
                data: Buffer.from("reference-bytes").toString("base64"),
              },
            },
            { text: "Change only the sky to a sunset." },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: {
          imageSize: "4K",
        },
      },
    });
  });

  it("forwards explicit aspect ratio without forcing a default when size is omitted", async () => {
    mockGoogleApiKeyAuth();
    const fetchMock = installGoogleFetchMock();

    await generateImage({
      model: "gemini-3-pro-image",
      prompt: "portrait photo",
      aspectRatio: "9:16",
    });

    const request = fetchRequest(fetchMock);
    expect(request.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent",
    );
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.body ?? "")).toEqual({
      contents: [
        {
          role: "user",
          parts: [{ text: "portrait photo" }],
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: {
          aspectRatio: "9:16",
        },
      },
    });
  });

  it("disables DNS pinning for Google image generation requests", async () => {
    mockGoogleApiKeyAuth();
    installGoogleFetchMock();
    const postJsonRequestSpy = vi.spyOn(providerHttp, "postJsonRequest");

    await generateImage({ prompt: "draw a fox" });

    expect(postJsonRequestOptions(postJsonRequestSpy).pinDns).toBe(false);
  });

  it("honors configured private-network opt-in for Google image generation", async () => {
    mockGoogleApiKeyAuth();
    installGoogleFetchMock();
    const postJsonRequestSpy = vi.spyOn(providerHttp, "postJsonRequest");

    await generateImage({
      prompt: "draw a fox",
      cfg: googleImageConfig({
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        request: { allowPrivateNetwork: true },
      }),
    });

    expect(postJsonRequestOptions(postJsonRequestSpy).allowPrivateNetwork).toBe(true);
  });

  it.each([
    {
      name: "normalizes a configured bare Google host to the v1beta API root",
      baseUrl: "https://generativelanguage.googleapis.com",
      prompt: "draw a cat",
    },
    {
      name: "strips a configured /openai suffix before calling the native Gemini image API",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      prompt: "draw a fox",
    },
  ])("$name", async ({ baseUrl, prompt }) => {
    mockGoogleApiKeyAuth();
    const fetchMock = installGoogleFetchMock();

    await generateImage({
      model: "gemini-3-pro-image",
      prompt,
      cfg: googleImageConfig({ baseUrl }),
    });

    const request = fetchRequest(fetchMock);
    expect(request.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent",
    );
    expect(typeof request.method).toBe("string");
  });

  it("reports configured from a config apiKey (gateway-routed gemini) with no env/profile creds", () => {
    const provider = buildGoogleImageGenerationProvider();
    expect(
      provider.isConfigured?.({
        agentDir: "/tmp/agent",
        cfg: googleImageConfig({
          baseUrl: "https://gateway.example.test/gemini/v1beta",
          apiKey: "gateway-token",
        }),
      }),
    ).toBe(true);
  });

  it("does not advertise Gemini images for OAuth and managed-secret marker strings", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GOOGLE_API_KEY", "");

    for (const apiKey of ["oauth:google", "secretref-managed", "gcp-vertex-credentials"]) {
      expect(
        buildGoogleImageGenerationProvider().isConfigured?.({
          cfg: googleImageConfig({ apiKey, baseUrl: "https://gateway.example.test/gemini/v1beta" }),
        }),
      ).toBe(false);
    }
  });

  it("still reports not configured with a custom endpoint and no credentials", () => {
    vi.spyOn(providerAuth, "isProviderApiKeyConfigured").mockReturnValue(false);

    const provider = buildGoogleImageGenerationProvider();
    expect(
      provider.isConfigured?.({
        agentDir: "/tmp/agent",
        cfg: googleImageConfig({ baseUrl: "https://gateway.example.test/gemini/v1beta" }),
      }),
    ).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", "   "],
  ])("treats a %s config apiKey as not configured", (_label, apiKey) => {
    vi.spyOn(providerAuth, "isProviderApiKeyConfigured").mockReturnValue(false);

    const provider = buildGoogleImageGenerationProvider();
    expect(
      provider.isConfigured?.({
        agentDir: "/tmp/agent",
        cfg: googleImageConfig({ baseUrl: "https://gateway.example.test/gemini/v1beta", apiKey }),
      }),
    ).toBe(false);
  });

  // Regression: credential preparation (OAuth refresh, profile lock) must share
  // the request timeout budget. resolveApiKeyForProvider is called before the
  // operation deadline and must receive an abort signal so a stalled credential
  // lookup is cancelled within req.timeoutMs instead of hanging indefinitely.
  // Uses fake timers so the regression is deterministic and does not depend on
  // the wall clock or the vitest per-test timeout.
  it("aborts credential preparation when it exceeds the request timeout", async () => {
    // Mirrors resolveApiKeyForProviderCore: honors the caller's signal by
    // rejecting when aborted (the real impl calls throwIfAborted() across the
    // OAuth refresh path). Without a signal (pre-fix), the wait is unbounded.
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockImplementation(
      (params: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const signal = params.signal;
          if (!signal) {
            return;
          }
          const rejectWithReason = () => {
            const reason = signal.reason;
            reject(reason instanceof Error ? reason : new Error("aborted"));
          };
          if (signal.aborted) {
            rejectWithReason();
            return;
          }
          signal.addEventListener("abort", rejectWithReason);
        }),
    );
    const postSpy = vi.spyOn(providerHttp, "postJsonRequest").mockResolvedValue({
      response: new Response("{}", { status: 200 }),
      release: () => {},
    } as never);

    vi.useFakeTimers();
    try {
      // Before the fix no signal is passed, so the credential lookup hangs
      // unbounded and this test times out. After the fix buildTimeoutAbortSignal
      // aborts the credential wait within the budget.
      const promise = generateImage({
        timeoutMs: 200,
        cfg: googleImageConfig({
          apiKey: "ignored",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        }),
      });

      // Attach the rejection assertion before advancing the clock so the abort
      // is observed deterministically.
      const assertion = expect(promise).rejects.toThrow(/timed out|aborted/i);

      await vi.advanceTimersByTimeAsync(200);

      await assertion;
      expect(postSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression: the operation timeout signal must cover the HTTP request too,
  // not only credential preparation. Without forwarding the signal,
  // postJsonRequest starts a fresh full operationTimeoutMs budget and can even
  // return success after the operation signal already expired.
  it("forwards the operation signal into the image HTTP request", async () => {
    let receivedSignal: AbortSignal | undefined;
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-test-key",
      source: "env",
      mode: "api-key",
    });
    vi.spyOn(providerHttp, "postJsonRequest").mockImplementation(
      (params: { signal?: AbortSignal }) => {
        receivedSignal = params.signal;
        // Stall past the operation budget; with the signal forwarded, the
        // request rejects via abort instead of running for a second full budget.
        return new Promise((_resolve, reject) => {
          const signal = params.signal;
          if (!signal) {
            return;
          }
          const rejectWithReason = () => {
            const reason = signal.reason;
            reject(reason instanceof Error ? reason : new Error("aborted"));
          };
          if (signal.aborted) {
            rejectWithReason();
            return;
          }
          signal.addEventListener("abort", rejectWithReason);
        });
      },
    );

    vi.useFakeTimers();
    try {
      const promise = generateImage({
        timeoutMs: 150,
        cfg: googleImageConfig({
          apiKey: "ignored",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        }),
      });

      const assertion = expect(promise).rejects.toThrow(/timed out|aborted/i);
      await vi.advanceTimersByTimeAsync(150);
      await assertion;

      // The signal reached the HTTP layer, so the request did not get an
      // independent second timeout budget.
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      expect(receivedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression: an omitted timeout must preserve the existing behavior — no
  // absolute deadline is imposed on credential preparation. buildTimeoutAbortSignal
  // returns no signal when timeoutMs is undefined, so a slow OAuth refresh is not
  // cancelled by the DEFAULT_IMAGE_TIMEOUT_MS fallback (only the HTTP layer keeps
  // its per-request default). This guards the compatibility decision called out in
  // review: the 180-second default must not silently extend into credential waits
  // that previously remained unbounded.
  it("does not apply an abort signal to credential preparation when timeout is omitted", async () => {
    let receivedSignal: AbortSignal | undefined;
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockImplementation(
      (params: { signal?: AbortSignal }) => {
        receivedSignal = params.signal;
        return new Promise(() => {
          // Never resolves; the point is to observe whether a signal was attached,
          // not to complete the request. Without a timeout, no abort fires.
        });
      },
    );
    vi.spyOn(providerHttp, "postJsonRequest").mockResolvedValue({
      response: new Response("{}", { status: 200 }),
      release: () => {},
    } as never);

    vi.useFakeTimers();
    try {
      // No timeoutMs: credential preparation must run without an abort signal.
      const promise = generateImage({
        cfg: googleImageConfig({
          apiKey: "ignored",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        }),
      });

      // Advance well past the DEFAULT_IMAGE_TIMEOUT_MS (180s). With the fix, no
      // signal was created, so credential preparation is still pending (not
      // aborted) and postJsonRequest was never reached.
      await vi.advanceTimersByTimeAsync(360_000);

      expect(receivedSignal).toBeUndefined();
      expect(providerHttp.postJsonRequest).not.toHaveBeenCalled();

      // Clean up the hanging promise to avoid unhandled rejection noise.
      promise.catch(() => {});
    } finally {
      vi.useRealTimers();
    }
  });
});

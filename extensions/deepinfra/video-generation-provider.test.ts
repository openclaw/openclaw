// Deepinfra tests cover video generation provider plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  requireFirstPostJsonRequest,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DEEPINFRA_VIDEO_FALLBACK_MODELS } from "./media-models.js";
import { MP4_VIDEO } from "./video-generation.test-support.js";

const {
  postJsonRequestMock,
  fetchWithTimeoutMock,
  pollProviderOperationJsonMock,
  resolveProviderHttpRequestConfigMock,
  sanitizeConfiguredModelProviderRequestMock,
} = getProviderHttpMocks();

let buildDeepInfraVideoGenerationProvider: typeof import("./video-generation-provider.js").buildDeepInfraVideoGenerationProvider;

beforeAll(async () => {
  ({ buildDeepInfraVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

const deepInfraVideoRequest = {
  provider: "deepinfra",
  model: DEEPINFRA_VIDEO_FALLBACK_MODELS[0],
  prompt: "A generated DeepInfra video",
  cfg: {},
} satisfies VideoGenerationRequest;

function mockSubmit(job: unknown, release = vi.fn(async () => {})): typeof release {
  postJsonRequestMock.mockImplementation(async () => ({
    response: Response.json(job),
    release,
  }));
  return release;
}

describe("deepinfra video generation provider", () => {
  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildDeepInfraVideoGenerationProvider());
  });

  it("uses the current DeepInfra text-to-video fallback model first", () => {
    const provider = buildDeepInfraVideoGenerationProvider();

    expect(provider.defaultModel).toBe("Pixverse/Pixverse-T2V");
    expect(provider.models?.slice(0, 3)).toEqual([
      "Pixverse/Pixverse-T2V",
      "Pixverse/Pixverse-T2V-HD",
      "Wan-AI/Wan2.6-T2V",
    ]);
  });

  it("submits an OpenAI video job, polls until succeeded, and returns the hosted output URL", async () => {
    vi.useFakeTimers();
    try {
      const release = mockSubmit({ id: "videos_abc", status: "queued" });
      fetchWithTimeoutMock.mockResolvedValueOnce(
        Response.json({ id: "videos_abc", status: "processing" }),
      );
      fetchWithTimeoutMock.mockResolvedValueOnce(
        Response.json({
          id: "videos_abc",
          status: "succeeded",
          model: "Pixverse/Pixverse-T2V",
          data: [{ url: "/generated/video.mp4" }],
        }),
      );

      const provider = buildDeepInfraVideoGenerationProvider();
      const pending = provider.generateVideo({
        provider: "deepinfra",
        model: "deepinfra/Pixverse/Pixverse-T2V",
        prompt: "A bicycle weaving through a rainy neon street",
        cfg: {},
        aspectRatio: "16:9",
        durationSeconds: 8,
        providerOptions: {
          seed: 42,
          negative_prompt: "blur",
          style: "anime",
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;

      expect(resolveProviderHttpRequestConfigMock.mock.calls).toEqual([
        [
          {
            baseUrl: "https://api.deepinfra.com/v1/openai",
            defaultBaseUrl: "https://api.deepinfra.com/v1/openai",
            defaultHeaders: {
              Authorization: "Bearer provider-key",
              "Content-Type": "application/json",
            },
            provider: "deepinfra",
            capability: "video",
            transport: "http",
            request: undefined,
          },
        ],
      ]);

      expect(postJsonRequestMock).toHaveBeenCalledOnce();
      const postRequest = requireFirstPostJsonRequest(
        postJsonRequestMock,
        "DeepInfra video submit request",
      );
      const postRequestHeaders = Reflect.get(postRequest ?? {}, "headers");
      expect(postRequestHeaders).toBeInstanceOf(Headers);
      expect(Object.fromEntries((postRequestHeaders as Headers).entries())).toEqual({
        authorization: "Bearer provider-key",
        "content-type": "application/json",
      });
      expect(postRequest).toEqual({
        url: "https://api.deepinfra.com/v1/openai/videos",
        headers: postRequestHeaders,
        body: {
          model: "Pixverse/Pixverse-T2V",
          prompt: "A bicycle weaving through a rainy neon street",
          aspect_ratio: "16:9",
          seconds: 8,
          seed: 42,
          negative_prompt: "blur",
          style: "anime",
        },
        timeoutMs: 60_000,
        fetchFn: fetch,
        allowPrivateNetwork: false,
        dispatcherPolicy: undefined,
      });

      expect(pollProviderOperationJsonMock).toHaveBeenCalledOnce();
      const pollUrls = fetchWithTimeoutMock.mock.calls.map((call) => call[0]);
      expect(pollUrls).toEqual([
        "https://api.deepinfra.com/v1/openai/videos/videos_abc",
        "https://api.deepinfra.com/v1/openai/videos/videos_abc",
      ]);

      expect(result.videos).toEqual([
        {
          url: "https://api.deepinfra.com/generated/video.mp4",
          mimeType: "video/mp4",
          fileName: "video-1.mp4",
        },
      ]);
      expect(result.model).toBe("Pixverse/Pixverse-T2V");
      expect(result.metadata).toEqual({
        jobId: "videos_abc",
        status: "succeeded",
      });
      expect(release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies configured request policy to OpenAI-compatible video requests", async () => {
    const requestPolicy = {
      allowPrivateNetwork: true,
      headers: { "X-DeepInfra-Route": "video-policy" },
    };
    const dispatcherPolicy = { mode: "env-proxy" as const };
    resolveProviderHttpRequestConfigMock.mockImplementationOnce((params) => {
      const headers = new Headers(params.defaultHeaders);
      for (const [key, value] of Object.entries(params.request?.headers ?? {})) {
        headers.set(key, value);
      }
      return {
        baseUrl: params.baseUrl ?? params.defaultBaseUrl,
        allowPrivateNetwork: params.request?.allowPrivateNetwork === true,
        headers,
        dispatcherPolicy,
      };
    });
    mockSubmit({
      id: "videos_policy",
      status: "succeeded",
      data: [{ url: "/generated/policy.mp4" }],
    });

    const provider = buildDeepInfraVideoGenerationProvider();
    await provider.generateVideo({
      provider: "deepinfra",
      model: "deepinfra/Pixverse/Pixverse-T2V",
      prompt: "A request policy video",
      cfg: {
        models: {
          providers: {
            deepinfra: {
              baseUrl: "https://api.deepinfra.com/v1/openai",
              models: [],
              request: requestPolicy,
            },
          },
        },
      },
    });

    expect(sanitizeConfiguredModelProviderRequestMock).toHaveBeenCalledWith(requestPolicy);
    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepinfra",
        capability: "video",
        transport: "http",
        request: requestPolicy,
      }),
    );
    const postRequest = requireFirstPostJsonRequest(
      postJsonRequestMock,
      "DeepInfra video submit request",
    );
    expect(Reflect.get(postRequest ?? {}, "allowPrivateNetwork")).toBe(true);
    expect(Reflect.get(postRequest ?? {}, "dispatcherPolicy")).toBe(dispatcherPolicy);
    const postRequestHeaders = Reflect.get(postRequest ?? {}, "headers");
    expect(postRequestHeaders).toBeInstanceOf(Headers);
    expect((postRequestHeaders as Headers).get("x-deepinfra-route")).toBe("video-policy");
  });

  it("returns immediately without polling when the submit response already succeeded", async () => {
    mockSubmit({
      id: "videos_fast",
      status: "succeeded",
      data: [{ url: "/generated/fast.mp4" }],
    });

    const provider = buildDeepInfraVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "deepinfra",
      model: "deepinfra/Pixverse/Pixverse-T2V",
      prompt: "An instant video",
      cfg: {},
    });

    expect(pollProviderOperationJsonMock).not.toHaveBeenCalled();
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    expect(result.videos).toEqual([
      {
        url: "https://api.deepinfra.com/generated/fast.mp4",
        mimeType: "video/mp4",
        fileName: "video-1.mp4",
      },
    ]);
    expect(result.metadata).toEqual({ jobId: "videos_fast", status: "succeeded" });
  });

  it("resolves relative video URLs against a configured OpenAI-compatible baseUrl", async () => {
    mockSubmit({
      id: "videos_custom",
      status: "succeeded",
      data: [{ url: "/generated/custom.mp4" }],
    });

    const provider = buildDeepInfraVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "deepinfra",
      model: "deepinfra/Pixverse/Pixverse-T2V",
      prompt: "A video from a custom endpoint",
      cfg: {
        models: {
          providers: {
            deepinfra: { baseUrl: "https://video.example.com/v1/openai" },
          },
        },
      } as unknown as OpenClawConfig,
    });

    expect(
      Reflect.get(
        requireFirstPostJsonRequest(postJsonRequestMock, "DeepInfra video submit request") ?? {},
        "url",
      ),
    ).toBe("https://video.example.com/v1/openai/videos");
    expect(result.videos).toEqual([
      {
        url: "https://video.example.com/generated/custom.mp4",
        mimeType: "video/mp4",
        fileName: "video-1.mp4",
      },
    ]);
  });

  it("ignores legacy nativeBaseUrl config; doctor owns its migration", async () => {
    mockSubmit({
      id: "videos_native",
      status: "succeeded",
      data: [{ url: "/generated/native.mp4" }],
    });

    const provider = buildDeepInfraVideoGenerationProvider();
    await provider.generateVideo({
      provider: "deepinfra",
      model: "deepinfra/Pixverse/Pixverse-T2V",
      prompt: "A video from a legacy config",
      cfg: {
        models: {
          providers: {
            deepinfra: { nativeBaseUrl: "https://gw.example.com/v1/inference" },
          },
        },
      } as unknown as OpenClawConfig,
    });

    expect(resolveProviderHttpRequestConfigMock.mock.calls[0]?.[0]).toMatchObject({
      baseUrl: "https://api.deepinfra.com/v1/openai",
    });
  });

  it("fails closed on a retired /v1/inference baseUrl without sending a request", async () => {
    const provider = buildDeepInfraVideoGenerationProvider();
    const error = await provider
      .generateVideo({
        provider: "deepinfra",
        model: "deepinfra/Pixverse/Pixverse-T2V",
        prompt: "A video against a retired endpoint",
        cfg: {
          models: {
            providers: {
              deepinfra: {
                // Assemble the fixture URL at runtime to avoid scanner false positives.
                baseUrl: ["https://user", "password@gw.example.com/v1/inference?token=secret"].join(
                  ":",
                ),
              },
            },
          },
        } as unknown as OpenClawConfig,
      })
      .then(
        () => undefined,
        (thrown: unknown) => (thrown instanceof Error ? thrown : new Error(String(thrown))),
      );

    expect(error?.message).toMatch(/retired native \/v1\/inference surface/u);
    expect(error?.message).toContain("openclaw doctor --fix");
    // Fail-closed means no submit request and no configured-URL echo (it may
    // carry credentials).
    expect(postJsonRequestMock).not.toHaveBeenCalled();
    expect(error?.message).not.toMatch(/password|secret|gw\.example\.com/u);
  });

  it("does not forward malformed video seed values", async () => {
    mockSubmit({
      id: "videos_seed",
      status: "succeeded",
      data: [{ url: "/generated/video.mp4" }],
    });

    const provider = buildDeepInfraVideoGenerationProvider();
    await provider.generateVideo({
      provider: "deepinfra",
      model: "deepinfra/Pixverse/Pixverse-T2V",
      prompt: "A bicycle weaving through a rainy neon street",
      cfg: {},
      providerOptions: {
        seed: 1.5,
      },
    });

    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    const postRequest = requireFirstPostJsonRequest(
      postJsonRequestMock,
      "DeepInfra video submit request",
    );
    expect(Reflect.get(Reflect.get(postRequest ?? {}, "body") ?? {}, "seed")).toBeUndefined();
  });

  it.each([
    { label: "HTML", url: "data:text/html;base64,PGh0bWw+" },
    { label: "JSON", url: "data:application/json;base64,e30=" },
    { label: "problem JSON", url: "data:application/problem+json;base64,e30=" },
    { label: "image", url: "data:image/png;base64,YQ==" },
    { label: "audio", url: "data:audio/mpeg;base64,YQ==" },
    { label: "empty video", url: "data:video/mp4;base64," },
    { label: "missing MIME type", url: "data:;base64,YQ==" },
    { label: "unexpected parameters", url: "data:video/mp4;charset=utf-8;base64,YQ==" },
  ])("rejects $label data URLs as malformed video outputs", async ({ url }) => {
    mockSubmit({
      id: "videos_invalid_media",
      status: "succeeded",
      data: [{ url }],
    });

    await expect(
      buildDeepInfraVideoGenerationProvider().generateVideo({
        ...deepInfraVideoRequest,
        prompt: "A response that is not a video",
      }),
    ).rejects.toThrow("DeepInfra video response: malformed video response");
  });

  it("rejects oversized inline videos before decoding their base64", async () => {
    mockSubmit({
      id: "videos_too_large",
      status: "succeeded",
      data: [{ url: "data:video/mp4;base64,YWI=" }],
    });
    const decodeSpy = vi.spyOn(Buffer, "from");

    try {
      await expect(
        buildDeepInfraVideoGenerationProvider().generateVideo({
          ...deepInfraVideoRequest,
          prompt: "A video larger than the configured media limit",
          cfg: { agents: { defaults: { mediaMaxMb: 1 / (1024 * 1024) } } },
        }),
      ).rejects.toThrow("DeepInfra generated video exceeds 1 bytes");
      const decodeCalls: ReadonlyArray<ReadonlyArray<unknown>> = decodeSpy.mock.calls;
      expect(decodeCalls.some((call) => call[1] === "base64")).toBe(false);
    } finally {
      decodeSpy.mockRestore();
    }
  });

  it.each([
    { label: "video", mime: "video/mp4" },
    { label: "generic binary", mime: "application/octet-stream" },
    { label: "incorrect video container", mime: "video/webm" },
  ])("detects an exact-limit MP4 with a $label label after polling", async ({ mime }) => {
    const release = mockSubmit({ id: "videos_at_limit", status: "processing" });
    fetchWithTimeoutMock.mockResolvedValueOnce(
      Response.json({
        id: "videos_at_limit",
        status: "succeeded",
        data: [{ url: `data:${mime};base64,${MP4_VIDEO.toString("base64")}` }],
      }),
    );
    const result = await buildDeepInfraVideoGenerationProvider().generateVideo({
      ...deepInfraVideoRequest,
      cfg: { agents: { defaults: { mediaMaxMb: MP4_VIDEO.length / (1024 * 1024) } } },
    });
    expect(result.videos[0]).toEqual({
      buffer: MP4_VIDEO,
      mimeType: "video/mp4",
      fileName: "video-1.mp4",
    });
    expect(result.metadata).toEqual({ jobId: "videos_at_limit", status: "succeeded" });
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "whitespace and newline",
      value: MP4_VIDEO.toString("base64").replace(/(.{40})/g, "$1\n "),
    },
    { label: "unpadded", value: MP4_VIDEO.toString("base64").replace(/=+$/, "") },
  ])("accepts valid $label base64 video outputs", async ({ value }) => {
    mockSubmit({
      id: "videos_normalized_base64",
      status: "succeeded",
      data: [{ url: `data:video/mp4;base64,${value}` }],
    });
    const result =
      await buildDeepInfraVideoGenerationProvider().generateVideo(deepInfraVideoRequest);
    expect(result.videos[0]?.buffer).toEqual(MP4_VIDEO);
  });

  it.each([
    { label: "unknown bytes", bytes: Buffer.from("binary"), mime: "application/octet-stream" },
    { label: "unknown bytes labeled video", bytes: Buffer.from("binary"), mime: "video/mp4" },
    {
      label: "image bytes labeled video",
      bytes: Buffer.from(
        "47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b",
        "hex",
      ),
      mime: "video/mp4",
    },
    {
      label: "audio container labeled video",
      bytes: Buffer.from("00000018667479704d344220000000004d34422000000000", "hex"),
      mime: "video/mp4",
    },
  ])("rejects $label after polling", async ({ bytes, mime }) => {
    const release = mockSubmit({ id: "videos_bad_bytes", status: "queued" });
    fetchWithTimeoutMock.mockResolvedValueOnce(
      Response.json({
        id: "videos_bad_bytes",
        status: "succeeded",
        data: [{ url: `data:${mime};base64,${bytes.toString("base64")}` }],
      }),
    );
    await expect(
      buildDeepInfraVideoGenerationProvider().generateVideo(deepInfraVideoRequest),
    ).rejects.toThrow("DeepInfra video response: malformed video response");
    expect(release).toHaveBeenCalledOnce();
  });

  it("throws the job error when the video generation fails", async () => {
    mockSubmit({ id: "videos_fail", status: "queued" });
    fetchWithTimeoutMock.mockResolvedValueOnce(
      Response.json({ id: "videos_fail", status: "failed", error: "model overloaded" }),
    );

    const provider = buildDeepInfraVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "deepinfra",
        model: "deepinfra/Pixverse/Pixverse-T2V",
        prompt: "A failing video",
        cfg: {},
      }),
    ).rejects.toThrow("model overloaded");
  });

  it("reports malformed submit JSON as a provider error", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockImplementation(async () => ({
      response: new Response("{", { headers: { "content-type": "application/json" } }),
      release,
    }));

    const provider = buildDeepInfraVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "deepinfra",
        model: "deepinfra/Pixverse/Pixverse-T2V",
        prompt: "A bicycle weaving through a rainy neon street",
        cfg: {},
      }),
    ).rejects.toThrow("DeepInfra video generation failed: malformed JSON response");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects malformed base64 data URL video outputs", async () => {
    mockSubmit({
      id: "videos_bad",
      status: "succeeded",
      data: [{ url: "data:video/webm;base64,not-base64!" }],
    });

    const provider = buildDeepInfraVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "deepinfra",
        model: "deepinfra/Pixverse/Pixverse-T2V",
        prompt: "A malformed WebM data URL",
        cfg: {},
      }),
    ).rejects.toThrow("DeepInfra video response returned malformed data URL base64");
  });
});

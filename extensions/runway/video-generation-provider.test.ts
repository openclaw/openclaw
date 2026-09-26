import {
  capturePluginRegistration,
  createRuntimeEnv,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();

let buildRunwayVideoGenerationProvider: typeof import("./video-generation-provider.js").buildRunwayVideoGenerationProvider;

beforeAll(async () => {
  ({ buildRunwayVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

function generateVideo(request: Partial<VideoGenerationRequest> = {}) {
  return buildRunwayVideoGenerationProvider().generateVideo({
    provider: "runway",
    model: "gen4.5",
    prompt: "a tiny lobster DJ under neon lights",
    cfg: {},
    ...request,
  });
}

function mockTaskResponse(payload: unknown) {
  postJsonRequestMock.mockResolvedValueOnce({
    response: Response.json({ id: "task-1" }),
    release: vi.fn(async () => {}),
  });
  fetchWithTimeoutMock.mockResolvedValueOnce(Response.json(payload));
}

function mockSuccessfulTask(
  video = new Response("mp4-bytes", { headers: { "content-type": "video/webm" } }),
) {
  mockTaskResponse({
    id: "task-1",
    status: "SUCCEEDED",
    output: ["https://example.com/out.mp4"],
  });
  fetchWithTimeoutMock.mockResolvedValueOnce(video);
}

describe("runway video generation provider", () => {
  it("registers media-only API-key onboarding alongside video generation", async () => {
    const { default: plugin } = await import("./index.js");
    const captured = capturePluginRegistration(plugin);

    expect(captured.videoGenerationProviders.map((provider) => provider.id)).toEqual(["runway"]);
    expect(captured.modelCatalogProviders).toEqual([]);
    expect(captured.providers).toHaveLength(1);
    expect(captured.providers[0]).toMatchObject({
      id: "runway",
      docsPath: "/providers/runway",
      envVars: ["RUNWAYML_API_SECRET", "RUNWAY_API_KEY"],
    });

    const choice = resolveProviderPluginChoice({
      providers: captured.providers,
      choice: "runway-api-key",
    });
    expect(choice?.method.id).toBe("api-key");
    expect(choice?.method.starterModel).toBeUndefined();
    expect(choice?.wizard?.onboardingScopes).toEqual(["image-generation"]);
    if (!choice?.method.validateNonInteractive) {
      throw new Error("expected Runway non-interactive API-key validation");
    }

    const resolveApiKey = vi.fn(async () => ({ key: "runway-test-key", source: "flag" as const }));
    expect(
      await choice.method.validateNonInteractive({
        authChoice: "runway-api-key",
        config: {},
        baseConfig: {},
        opts: { runwayApiKey: "runway-test-key" },
        runtime: createRuntimeEnv(),
        resolveApiKey,
      }),
    ).toBe(true);
    expect(resolveApiKey).toHaveBeenCalledWith({
      provider: "runway",
      flagValue: "runway-test-key",
      flagName: "--runway-api-key",
      envVar: "RUNWAYML_API_SECRET",
    });
  });

  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildRunwayVideoGenerationProvider());
  });

  it("submits a text-to-video task, polls it, and downloads the output", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      mockSuccessfulTask();
      const result = await generateVideo({ durationSeconds: 4, aspectRatio: "16:9" });

      expect(postJsonRequestMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          url: "https://api.dev.runwayml.com/v1/text_to_video",
          body: {
            model: "gen4.5",
            promptText: "a tiny lobster DJ under neon lights",
            ratio: "1280:720",
            duration: 4,
          },
        }),
      );
      expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
        1,
        "https://api.dev.runwayml.com/v1/tasks/task-1",
        expect.objectContaining({ method: "GET", headers: expect.any(Headers) }),
        120000,
        fetch,
      );
      expect(result.videos).toEqual([
        expect.objectContaining({ fileName: "video-1.webm", buffer: Buffer.from("mp4-bytes") }),
      ]);
      expect(result.metadata).toMatchObject({
        taskId: "task-1",
        status: "SUCCEEDED",
        endpoint: "/v1/text_to_video",
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects an empty generated video", async () => {
    mockSuccessfulTask(new Response("", { headers: { "content-type": "video/mp4" } }));

    await expect(generateVideo()).rejects.toThrow(
      "Runway generated video download: malformed video response",
    );
  });

  it("rejects generated video downloads that exceed the configured media cap", async () => {
    mockSuccessfulTask(new Response("too-large", { headers: { "content-type": "video/mp4" } }));

    await expect(
      generateVideo({ cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } } }),
    ).rejects.toThrow("Runway generated video download exceeds 1 bytes");
  });

  it("does not round malformed duration values into create requests", async () => {
    mockSuccessfulTask();
    await generateVideo({ durationSeconds: 4.5, aspectRatio: "16:9" });

    expect(postJsonRequestMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ body: expect.objectContaining({ duration: 5 }) }),
    );
  });

  it("accepts local image buffers by converting them into data URIs", async () => {
    mockSuccessfulTask();
    await generateVideo({
      model: "gen4_turbo",
      prompt: "animate this frame",
      inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
      aspectRatio: "1:1",
      durationSeconds: 6,
    });

    expect(postJsonRequestMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        url: "https://api.dev.runwayml.com/v1/image_to_video",
        body: expect.objectContaining({
          promptImage: "data:image/png;base64,cG5nLWJ5dGVz",
          ratio: "960:960",
          duration: 6,
        }),
      }),
    );
  });

  it("requires gen4_aleph for video-to-video", async () => {
    await expect(
      generateVideo({ inputVideos: [{ url: "https://example.com/input.mp4" }] }),
    ).rejects.toThrow("Runway video-to-video currently requires model gen4_aleph.");
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("reports malformed create JSON with a provider-owned error", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValueOnce({
      response: new Response("{ not json", { headers: { "content-type": "application/json" } }),
      release,
    });

    await expect(generateVideo()).rejects.toThrow(
      "Runway video generation failed: malformed JSON response",
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects status responses missing a task status", async () => {
    mockTaskResponse({ id: "task-1", output: ["https://example.com/out.mp4"] });

    await expect(generateVideo()).rejects.toThrow(
      "Runway video status response missing task status",
    );
  });

  it("rejects malformed completed output URLs", async () => {
    mockTaskResponse({
      id: "task-1",
      status: "SUCCEEDED",
      output: "https://example.com/out.mp4",
    });

    await expect(generateVideo()).rejects.toThrow(
      "Runway video generation completed with malformed output URLs",
    );
  });
});

import {
  capturePluginRegistration,
  createRuntimeEnv,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  requireFirstPostJsonRecordRequest,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { afterEach, assert, expect, it, vi } from "vitest";
import { testVideoGenerationDeadlines } from "../test-support/video-generation-deadline.test-support.js";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();
const prompt = "a tiny lobster DJ under neon lights";
const defaults = { provider: "runway", model: "gen4.5", prompt };
const outputUrl = "https://example.com/out.mp4";
type Request = Partial<VideoGenerationRequest>;

installProviderHttpMockCleanup();
afterEach(clearRuntimeConfigSnapshot);

async function generateVideo(request: Request = {}) {
  const { buildRunwayVideoGenerationProvider } = await import("./video-generation-provider.js");
  return buildRunwayVideoGenerationProvider().generateVideo({ ...defaults, cfg: {}, ...request });
}

function mockSubmission(reply = Response.json({ id: "task-1" })) {
  const release = vi.fn(async () => {});
  postJsonRequestMock.mockResolvedValueOnce({ response: reply, release });
  return release;
}

function mockTaskResponse(payload: unknown) {
  const release = mockSubmission();
  fetchWithTimeoutMock.mockResolvedValueOnce(Response.json(payload));
  return release;
}

function response(body: string, mimeType = "video/mp4") {
  return new Response(body, { headers: { "content-type": mimeType } });
}

function mockSuccessfulTask(video = response("mp4-bytes", "video/webm")) {
  const release = mockTaskResponse({ status: "SUCCEEDED", output: [outputUrl] });
  fetchWithTimeoutMock.mockResolvedValueOnce(video);
  return release;
}

function expectCreate(body: unknown, endpoint = "text_to_video") {
  expect(postJsonRequestMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ url: `https://api.dev.runwayml.com/v1/${endpoint}`, body }),
  );
}

type ApiKey = string | { source: "file"; provider: string; id: string };
function providerConfig(apiKey: ApiKey): OpenClawConfig {
  return { models: { providers: { runway: { baseUrl: "", models: [], apiKey } } } };
}

it("registers media-only API-key onboarding alongside video generation", async () => {
  const { default: plugin } = await import("./index.js");
  const captured = capturePluginRegistration(plugin);

  expect(captured).toMatchObject({
    videoGenerationProviders: [{ id: "runway" }],
    modelCatalogProviders: [],
    providers: [
      {
        id: "runway",
        docsPath: "/providers/runway",
        envVars: ["RUNWAYML_API_SECRET", "RUNWAY_API_KEY"],
      },
    ],
  });

  const choice = resolveProviderPluginChoice({
    providers: captured.providers,
    choice: "runway-api-key",
  });
  expect(choice).toMatchObject({
    method: { id: "api-key", starterModel: undefined },
    wizard: { onboardingScopes: ["image-generation"] },
  });
  assert(choice?.method.validateNonInteractive);

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

it.each<[string, Request, Record<string, unknown>]>([
  [
    "text_to_video",
    { durationSeconds: 4.5, aspectRatio: "16:9" },
    { model: "gen4.5", promptText: prompt, ratio: "1280:720", duration: 5 },
  ],
  [
    "image_to_video",
    {
      model: "gen4_turbo",
      inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
      aspectRatio: "1:1",
      durationSeconds: 6,
    },
    { promptImage: "data:image/png;base64,cG5nLWJ5dGVz", ratio: "960:960", duration: 6 },
  ],
])("submits %s, polls, and downloads the output", async (endpoint, request, body) => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  try {
    mockSuccessfulTask();
    const result = await generateVideo(request);

    expectCreate(endpoint === "text_to_video" ? body : expect.objectContaining(body), endpoint);
    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      1,
      "https://api.dev.runwayml.com/v1/tasks/task-1",
      expect.objectContaining({ method: "GET", headers: expect.any(Headers) }),
      120000,
      fetch,
    );
    expect(result).toMatchObject({
      videos: [{ fileName: "video-1.webm", buffer: Buffer.from("mp4-bytes") }],
      metadata: { taskId: "task-1", status: "SUCCEEDED", endpoint: `/v1/${endpoint}` },
    });
  } finally {
    clock.mockRestore();
  }
});

it("authenticates video generation with a resolved file SecretRef provider overlay", async () => {
  const sourceConfig = providerConfig({ source: "file", provider: "x", id: "/runway" });
  setRuntimeConfigSnapshot(providerConfig("runway-resolved-test-key"), sourceConfig);
  const providerAuth = await import("openclaw/plugin-sdk/provider-auth-runtime");
  const realAuth = await vi.importActual<typeof providerAuth>(
    "openclaw/plugin-sdk/provider-auth-runtime",
  );
  await vi
    .mocked(providerAuth.resolveApiKeyForProvider)
    .withImplementation(realAuth.resolveApiKeyForProvider, async () => {
      mockSuccessfulTask();
      await generateVideo({ cfg: sourceConfig, authStore: { version: 1, profiles: {} } });

      const { headers } = requireFirstPostJsonRecordRequest(postJsonRequestMock, "Runway");
      assert(headers instanceof Headers);
      expect(headers.get("authorization")).toBe("Bearer runway-resolved-test-key");
    });
});

type Failure = [string, Request, (() => ReturnType<typeof mockSubmission>)?];
it.each<Failure>([
  ["durationSeconds must be a positive duration", { durationSeconds: 0.4 }],
  [
    "Runway video-to-video currently requires model gen4_aleph.",
    { inputVideos: [{ url: "https://example.com/input.mp4" }] },
  ],
  [
    "Runway video generation failed: malformed JSON response",
    {},
    () => mockSubmission(response("{ not json", "application/json")),
  ],
  ["Runway video status response missing task status", {}, () => mockTaskResponse({})],
  [
    "Runway video generation completed with malformed output URLs",
    {},
    () => mockTaskResponse({ status: "SUCCEEDED", output: outputUrl }),
  ],
  [
    "Runway generated video download: malformed video response",
    {},
    () => mockSuccessfulTask(response("")),
  ],
  [
    "Runway generated video download exceeds 1 bytes",
    { cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } } },
    () => mockSuccessfulTask(response("too-large")),
  ],
])("rejects: %s", async (error, request, setup) => {
  const release = setup?.();
  await expect(generateVideo(request)).rejects.toThrow(error);
  if (release) {
    expect(release).toHaveBeenCalledOnce();
  } else {
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  }
});

testVideoGenerationDeadlines({
  providerId: "runway",
  model: "gen4.5",
  pendingStatus: "RUNNING",
  loadPlugin: async () => (await import("./index.js")).default,
});

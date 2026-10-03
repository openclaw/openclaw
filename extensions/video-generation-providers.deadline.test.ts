import {
  capturePluginRegistration,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import type {
  VideoGenerationProvider,
  VideoGenerationResult,
} from "openclaw/plugin-sdk/video-generation";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();
const videoUrl = "https://example.com/generated.mp4";
const videoBytes = Buffer.from("generated-video");
let providers: VideoGenerationProvider[];

beforeAll(async () => {
  const [{ default: runway }, { default: together }] = await Promise.all([
    import("./runway/index.js"),
    import("./together/index.js"),
  ]);
  providers = [
    ...capturePluginRegistration(runway).videoGenerationProviders,
    ...capturePluginRegistration(together).videoGenerationProviders,
  ];
});

installProviderHttpMockCleanup();
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe.each([
  { providerId: "runway", model: "gen4.5", pendingStatus: "RUNNING" },
  { providerId: "together", model: "Wan-AI/Wan2.2-T2V-A14B", pendingStatus: "in_progress" },
])("$providerId video generation deadlines", ({ providerId, model, pendingStatus }) => {
  it.each([
    {
      name: "finishes beyond the HTTP timeout within the requested operation budget",
      timeoutMs: 180_000,
      readyAfterMs: 150_000,
      pendingAtMs: undefined,
      settleByMs: 151_000,
      expectedTimeoutMs: undefined,
    },
    {
      name: "expires at the original deadline after a slow submission",
      timeoutMs: 180_000,
      readyAfterMs: Infinity,
      pendingAtMs: 175_000,
      settleByMs: 181_000,
      expectedTimeoutMs: 180_000,
    },
    {
      name: "retains the default polling budget after a slow submission",
      timeoutMs: undefined,
      readyAfterMs: Infinity,
      pendingAtMs: 125_000,
      settleByMs: 131_000,
      expectedTimeoutMs: 120_000,
    },
  ])("$name", async ({ timeoutMs, readyAfterMs, pendingAtMs, settleByMs, expectedTimeoutMs }) => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockImplementation(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 10_000);
      });
      return {
        response: Response.json({ id: "task-1", status: pendingStatus }),
        release,
      };
    });
    fetchWithTimeoutMock.mockImplementation(async (url) => {
      if (url === videoUrl) {
        return new Response(videoBytes, { headers: { "content-type": "video/mp4" } });
      }
      const ready = Date.now() - startedAt >= readyAfterMs;
      return Response.json({
        id: "task-1",
        status: ready ? (providerId === "runway" ? "SUCCEEDED" : "completed") : pendingStatus,
        ...(ready
          ? providerId === "runway"
            ? { output: [videoUrl] }
            : { outputs: { video_url: videoUrl } }
          : {}),
      });
    });

    let outcome:
      | { result: VideoGenerationResult; error?: never }
      | { error: unknown; result?: never }
      | undefined;
    const provider = requireRegisteredProvider(providers, providerId, "video provider");
    void provider
      .generateVideo({
        provider: providerId,
        model,
        prompt: "A blue cube on a studio floor",
        cfg: {},
        timeoutMs,
      })
      .then(
        (result) => {
          outcome = { result };
        },
        (error: unknown) => {
          outcome = { error };
        },
      );
    if (pendingAtMs !== undefined) {
      await vi.advanceTimersByTimeAsync(pendingAtMs);
      expect(outcome).toBeUndefined();
    }
    await vi.advanceTimersByTimeAsync(settleByMs - (pendingAtMs ?? 0));

    if (expectedTimeoutMs === undefined) {
      expect(outcome).toMatchObject({
        result: { videos: [{ mimeType: "video/mp4", buffer: videoBytes }] },
      });
    } else {
      expect(outcome?.error).toBeInstanceOf(Error);
      expect(outcome?.error).toMatchObject({
        message: expect.stringContaining(`timed out after ${expectedTimeoutMs}ms`),
      });
      expect(fetchWithTimeoutMock.mock.calls.some(([url]) => url === videoUrl)).toBe(false);
    }
    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});

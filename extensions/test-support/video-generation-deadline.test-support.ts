import {
  capturePluginRegistration,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { getProviderHttpMocks } from "openclaw/plugin-sdk/provider-http-test-mocks";
import type {
  VideoGenerationProvider,
  VideoGenerationResult,
} from "openclaw/plugin-sdk/video-generation";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const videoUrl = "https://example.com/generated.mp4";
const videoBytes = Buffer.from("generated-video");

export function testVideoGenerationDeadlines({
  providerId,
  model,
  pendingStatus,
  defaultPollingTimeoutMs = 120_000,
  loadPlugin,
}: {
  providerId: "runway" | "together";
  model: string;
  pendingStatus: string;
  defaultPollingTimeoutMs?: number;
  loadPlugin: () => Promise<Parameters<typeof capturePluginRegistration>[0]>;
}) {
  describe(`${providerId} video generation deadlines`, () => {
    const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();
    let provider: VideoGenerationProvider;
    beforeAll(async () => {
      provider = requireRegisteredProvider(
        capturePluginRegistration(await loadPlugin()).videoGenerationProviders,
        providerId,
        "video provider",
      );
    });
    afterEach(() => {
      vi.clearAllTimers();
      vi.useRealTimers();
    });
    it.each<[string, number | undefined, number, number | undefined]>([
      ["outlasts HTTP timeout within budget", 180_000, 150_000, undefined],
      ["expires at original deadline after slow submission", 180_000, Infinity, 175_000],
      [
        "finishes near default polling deadline after slow submission",
        undefined,
        defaultPollingTimeoutMs + 5_000,
        defaultPollingTimeoutMs,
      ],
    ])("%s", async (_, timeoutMs, readyAfterMs, pendingAtMs) => {
      const settleByMs = Math.min(readyAfterMs, timeoutMs ?? Infinity) + 1_000;
      vi.useFakeTimers();
      const startedAt = Date.now();
      const release = vi.fn(async () => {});
      const completed =
        providerId === "runway"
          ? { status: "SUCCEEDED", output: [videoUrl] }
          : { status: "completed", outputs: { video_url: videoUrl } };
      postJsonRequestMock.mockImplementation(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 10_000);
        });
        return { response: Response.json({ id: "task-1", status: pendingStatus }), release };
      });
      fetchWithTimeoutMock.mockImplementation(async (url) => {
        if (url === videoUrl) {
          return new Response(videoBytes, { headers: { "content-type": "video/mp4" } });
        }
        const ready = Date.now() - startedAt >= readyAfterMs;
        return Response.json({ id: "task-1", ...(ready ? completed : { status: pendingStatus }) });
      });
      let outcome: { result: VideoGenerationResult } | { error: unknown } | undefined;
      void provider
        .generateVideo({ provider: providerId, model, prompt: "A blue cube", cfg: {}, timeoutMs })
        .then(
          (result) => (outcome = { result }),
          (error: unknown) => (outcome = { error }),
        );
      if (pendingAtMs !== undefined) {
        await vi.advanceTimersByTimeAsync(pendingAtMs);
        expect(outcome).toBeUndefined();
      }
      await vi.advanceTimersByTimeAsync(settleByMs - (pendingAtMs ?? 0));

      if (Number.isFinite(readyAfterMs)) {
        expect(outcome).toMatchObject({
          result: { videos: [{ mimeType: "video/mp4", buffer: videoBytes }] },
        });
      } else {
        expect(outcome).toHaveProperty("error", expect.any(Error));
        expect(outcome).toHaveProperty(
          "error.message",
          expect.stringContaining(`timed out after ${timeoutMs}ms`),
        );
        expect(fetchWithTimeoutMock.mock.calls.some(([url]) => url === videoUrl)).toBe(false);
      }
      expect(postJsonRequestMock).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    });
  });
}

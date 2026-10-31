import {
  capturePluginRegistration,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { getProviderHttpMocks } from "openclaw/plugin-sdk/provider-http-test-mocks";
import { afterEach, describe, expect, it, vi } from "vitest";

const videoUrl = "https://example.com/generated.mp4";
const videoBytes = Buffer.from("generated-video");

export function testVideoGenerationDeadlines({
  providerId,
  model,
  pendingStatus,
  defaultPollingTimeoutMs: budget = 120_000,
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
    const request = { provider: providerId, model, prompt: "A blue cube", cfg: {} };
    afterEach(() => {
      vi.clearAllTimers();
      vi.useRealTimers();
    });
    it.each<[number | undefined, number, number | undefined]>([
      [180_000, 150_000, undefined],
      [180_000, Infinity, 175_000],
      [undefined, budget + 5_000, budget],
    ])("budget/ready/pending: %s/%s/%s", async (timeoutMs, readyAfterMs, pendingAtMs) => {
      const { videoGenerationProviders } = capturePluginRegistration(await loadPlugin());
      const provider = requireRegisteredProvider(videoGenerationProviders, providerId);
      const settleByMs = Math.min(readyAfterMs, timeoutMs ?? Infinity) + 1_000;
      vi.useFakeTimers();
      const startedAt = Date.now();
      const release = vi.fn(async () => {});
      const pending = { id: "task-1", status: pendingStatus };
      const completed =
        providerId === "runway"
          ? { status: "SUCCEEDED", output: [videoUrl] }
          : { status: "completed", outputs: { video_url: videoUrl } };
      postJsonRequestMock.mockImplementation(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 10_000);
        });
        return { response: Response.json(pending), release };
      });
      fetchWithTimeoutMock.mockImplementation(async (url) => {
        if (url === videoUrl) {
          return new Response(videoBytes, { headers: { "content-type": "video/mp4" } });
        }
        const ready = Date.now() - startedAt >= readyAfterMs;
        return Response.json({ ...pending, ...(ready ? completed : {}) });
      });
      const outcome = provider.generateVideo({ ...request, timeoutMs });
      const settled = vi.fn();
      void outcome.then(settled, settled);
      if (pendingAtMs !== undefined) {
        await vi.advanceTimersByTimeAsync(pendingAtMs);
        expect(settled).not.toHaveBeenCalled();
      }
      await vi.advanceTimersByTimeAsync(settleByMs - (pendingAtMs ?? 0));
      expect(settled).toHaveBeenCalledOnce();
      if (Number.isFinite(readyAfterMs)) {
        await expect(outcome).resolves.toMatchObject({
          videos: [{ mimeType: "video/mp4", buffer: videoBytes }],
        });
      } else {
        await expect(outcome).rejects.toBeInstanceOf(Error);
        await expect(outcome).rejects.toThrow(`timed out after ${timeoutMs}ms`);
        expect(fetchWithTimeoutMock.mock.calls.some(([url]) => url === videoUrl)).toBe(false);
      }
      expect(postJsonRequestMock).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    });
  });
}

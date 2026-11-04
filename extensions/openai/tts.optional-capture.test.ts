import { beforeEach, expect, it, vi } from "vitest";
import { buildOpenAISpeechProvider } from "./speech-provider.js";

const mocks = vi.hoisted(() => ({
  capture: vi.fn<typeof import("openclaw/plugin-sdk/proxy-capture").captureHttpExchangeAsync>(),
  fetch: vi.fn(),
  release: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/proxy-capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/proxy-capture")>()),
  captureHttpExchangeAsync: mocks.capture,
  isDebugProxyGlobalFetchPatchInstalled: () => false,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: mocks.fetch,
}));

beforeEach(() => {
  mocks.capture.mockReset().mockResolvedValue(undefined);
  mocks.release.mockReset().mockResolvedValue(undefined);
  mocks.fetch.mockReset().mockResolvedValue({
    response: new Response(Buffer.from("speech"), { headers: { "content-type": "audio/mpeg" } }),
    release: mocks.release,
  });
});

it.each(["present", "rejected"] as const)(
  "returns synthesized audio and releases transport when async capture is %s",
  async (capture) => {
    if (capture === "rejected") {
      mocks.capture.mockRejectedValue(new Error("diagnostic store failed"));
    }
    await expect(
      buildOpenAISpeechProvider().synthesize({
        text: "Hello",
        cfg: {},
        providerConfig: { apiKey: "fixture-key", model: "tts-1", voice: "alloy" },
        target: "audio-file",
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ audioBuffer: Buffer.from("speech") });
    expect(mocks.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://api.openai.com/v1/audio/speech" }),
    );
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({ meta: { provider: "openai", capability: "tts" } }),
    );
  },
);

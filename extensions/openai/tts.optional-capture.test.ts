import { beforeEach, expect, it, vi } from "vitest";
import { openaiTTS } from "./tts.js";

const mocks = vi.hoisted(() => ({
  captureAvailable: true,
  capture: vi.fn<typeof import("openclaw/plugin-sdk/proxy-capture").captureHttpExchangeAsync>(),
  fetch: vi.fn(),
  release: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/proxy-capture", () => ({
  get captureHttpExchangeAsync() {
    return mocks.captureAvailable ? mocks.capture : undefined;
  },
  isDebugProxyGlobalFetchPatchInstalled: () => false,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetch,
  ssrfPolicyFromHttpBaseUrlAllowedHostname: () => undefined,
}));

beforeEach(() => {
  mocks.capture.mockReset().mockResolvedValue(undefined);
  mocks.release.mockReset().mockResolvedValue(undefined);
  mocks.fetch.mockReset().mockResolvedValue({
    response: new Response(Buffer.from("speech"), { headers: { "content-type": "audio/mpeg" } }),
    release: mocks.release,
  });
});

it.each(["absent", "present", "rejected"] as const)(
  "returns synthesized audio and releases transport when async capture is %s",
  async (capture) => {
    mocks.captureAvailable = capture !== "absent";
    if (capture === "rejected") {
      mocks.capture.mockRejectedValue(new Error("diagnostic store failed"));
    }
    await expect(
      openaiTTS({
        text: "Hello",
        apiKey: "fixture-key",
        baseUrl: "https://api.openai.com/v1",
        model: "tts-1",
        voice: "alloy",
        responseFormat: "mp3",
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual(Buffer.from("speech"));
    expect(mocks.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://api.openai.com/v1/audio/speech" }),
    );
    expect(mocks.release).toHaveBeenCalledOnce();
    if (capture === "absent") {
      expect(mocks.capture).not.toHaveBeenCalled();
    } else {
      expect(mocks.capture).toHaveBeenCalledWith(
        expect.objectContaining({ meta: { provider: "openai", capability: "tts" } }),
      );
    }
  },
);

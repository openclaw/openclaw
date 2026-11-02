import { beforeEach, expect, it, vi } from "vitest";
import { buildMicrosoftSpeechProvider } from "./speech-provider.js";

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
    response: new Response(JSON.stringify([{ ShortName: "en-US-AvaNeural" }])),
    release: mocks.release,
  });
});

it.each(["present", "rejected"] as const)(
  "lists voices and releases transport when async capture is %s",
  async (capture) => {
    if (capture === "rejected") {
      mocks.capture.mockRejectedValue(new Error("diagnostic store failed"));
    }
    const listVoices = buildMicrosoftSpeechProvider().listVoices;
    if (!listVoices) {
      throw new Error("Microsoft voice listing is unavailable");
    }
    await expect(listVoices({ providerConfig: {} })).resolves.toEqual([
      expect.objectContaining({ id: "en-US-AvaNeural" }),
    ]);
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({ meta: { provider: "microsoft", capability: "speech-voices" } }),
    );
  },
);

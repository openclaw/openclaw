import { beforeEach, expect, it, vi } from "vitest";
import { buildMicrosoftSpeechProvider } from "./speech-provider.js";

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
    response: new Response(JSON.stringify([{ ShortName: "en-US-AvaNeural" }])),
    release: mocks.release,
  });
});

it.each(["absent", "present", "rejected"] as const)(
  "lists voices and releases transport when async capture is %s",
  async (capture) => {
    mocks.captureAvailable = capture !== "absent";
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
    if (capture === "absent") {
      expect(mocks.capture).not.toHaveBeenCalled();
    } else {
      expect(mocks.capture).toHaveBeenCalledWith(
        expect.objectContaining({ meta: { provider: "microsoft", capability: "speech-voices" } }),
      );
    }
  },
);

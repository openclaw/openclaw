// Google video generation transport-boundary tests run the pinned @google/genai
// SDK client for real (only fetch is stubbed) so the physical POST count after
// transient failures is covered at the SDK transport boundary.
import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { googleVideoGenerationProvider } from "./video-generation-provider.js";

function mockGoogleApiKeyAuth(apiKey = "google-key") {
  vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
    apiKey,
    source: "env",
    mode: "api-key",
  });
}

function generateVideo(overrides: Partial<VideoGenerationRequest> = {}) {
  return googleVideoGenerationProvider.generateVideo({
    provider: "google",
    model: "gemini-omni-1.1-flash",
    prompt: "A tiny robot watering a windowsill garden",
    cfg: {},
    ...overrides,
  });
}

let ssrfMock: { mockRestore: () => void } | undefined;

describe("google video generation SDK transport boundary", () => {
  beforeEach(() => {
    ssrfMock = mockPinnedHostnameResolution();
  });

  afterEach(() => {
    ssrfMock?.mockRestore();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("submits exactly one POST for the paid creation when the response is a transient 5xx", async () => {
    mockGoogleApiKeyAuth();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("server exploded", { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error: unknown = await generateVideo().catch((cause: unknown) => cause);
    assert(error instanceof Error);

    // The SDK's default retry policy would resubmit the billed request four
    // more times; the provider must disable per-request retries for creation.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    assert(firstCall, "expected the SDK to issue a fetch request");
    const [input, init] = firstCall;
    const requestUrl =
      input instanceof Request ? input.url : typeof input === "string" ? input : input.toString();
    expect(requestUrl).toContain("/interactions");
    expect(init?.method ?? (input instanceof Request ? input.method : undefined)).toBe("POST");
  });
});

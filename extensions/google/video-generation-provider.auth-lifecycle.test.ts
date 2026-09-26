// Real-entrypoint proof: drives the REAL `@google/genai` SDK (transport not
// mocked) through `buildGoogleVideoGenerationProvider().generateVideo`, stubbing
// only global `fetch` and `resolveApiKeyForProvider`. Mirrors the xAI auth-
// lifecycle proof from #154559 (extensions/xai/web-search.auth-lifecycle.test.ts).
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerAuthRuntimeMocks = vi.hoisted(() => ({
  resolveApiKeyForProvider: vi.fn().mockResolvedValue({
    apiKey: "google-key",
    source: "env",
    mode: "api-key",
  }),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: providerAuthRuntimeMocks.resolveApiKeyForProvider,
}));

import { buildGoogleVideoGenerationProvider } from "./video-generation-provider.js";

// Completed MLDev operation with inline video bytes. The SDK maps
// response.generateVideoResponse.generatedSamples[].video.encodedVideo to
// generatedVideos[].video.videoBytes, which extractGeneratedVideos reads.
function completedInlineVideoOperation() {
  return {
    done: true,
    response: {
      generateVideoResponse: {
        generatedSamples: [
          {
            video: {
              encodedVideo: Buffer.from("proof-mp4-bytes").toString("base64"),
              encoding: "video/mp4",
            },
          },
        ],
      },
    },
  };
}

function installGoogleFetch() {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(completedInlineVideoOperation()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// Mirrors resolveApiKeyForProviderCore: honors the caller's signal by rejecting
// on abort (the real impl calls throwIfAborted() across the OAuth refresh path).
function rejectWithAbortError(signal: AbortSignal, reject: (reason: Error) => void) {
  const reason = signal.reason;
  reject(reason instanceof Error ? reason : new Error("aborted"));
}

function stallingCredential() {
  providerAuthRuntimeMocks.resolveApiKeyForProvider.mockImplementationOnce(
    (params: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const signal = params.signal;
        if (!signal) {
          return;
        }
        if (signal.aborted) {
          rejectWithAbortError(signal, reject);
          return;
        }
        signal.addEventListener("abort", () => rejectWithAbortError(signal, reject), {
          once: true,
        });
      }),
  );
}

function generateVideo(overrides: Partial<VideoGenerationRequest> = {}) {
  return buildGoogleVideoGenerationProvider().generateVideo({
    provider: "google",
    model: "veo-3.1-fast-generate-preview",
    prompt: "A tiny robot watering a windowsill garden",
    cfg: {},
    ...overrides,
  });
}

let ssrfMock: { mockRestore: () => void } | undefined;

beforeEach(() => {
  ssrfMock = mockPinnedHostnameResolution();
  providerAuthRuntimeMocks.resolveApiKeyForProvider
    .mockReset()
    .mockResolvedValue({ apiKey: "google-key", source: "env", mode: "api-key" });
});

afterEach(() => {
  ssrfMock?.mockRestore();
  ssrfMock = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("google video generation auth lifecycle", () => {
  it("cancels credential preparation on timeout without starting a generation request", async () => {
    vi.useFakeTimers();
    stallingCredential();
    const fetchMock = installGoogleFetch();

    const promise = generateVideo({ timeoutMs: 200 });
    const assertion = expect(promise).rejects.toThrow(/timed out|aborted/i);
    await vi.advanceTimersByTimeAsync(200);
    await assertion;

    // No late generation request: the real SDK never reached fetch.
    expect(fetchMock).not.toHaveBeenCalled();
    // The credential-stage abort timer is released by `finally { cleanup() }`.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers and generates video after a prior credential timeout", async () => {
    // First request: credential stalls, cancelled by the timeout budget.
    vi.useFakeTimers();
    stallingCredential();
    const fetchMock = installGoogleFetch();

    const first = generateVideo({ timeoutMs: 200 });
    const firstAssertion = expect(first).rejects.toThrow(/timed out|aborted/i);
    await vi.advanceTimersByTimeAsync(200);
    await firstAssertion;
    expect(fetchMock).not.toHaveBeenCalled();
    vi.useRealTimers();

    // Second request: credential settles, the real entrypoint generates video.
    const result = await generateVideo({ timeoutMs: 5_000 });

    expect(fetchMock).toHaveBeenCalled();
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.buffer).toEqual(Buffer.from("proof-mp4-bytes"));
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
  });
});

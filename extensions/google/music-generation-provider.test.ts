// Google tests cover music generation provider plugin behavior.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const { createGoogleGenAIMock, generateContentMock } = vi.hoisted(() => {
  const generateContentMockLocal = vi.fn();
  const createGoogleGenAIMockLocal = vi.fn(() => {
    return {
      models: {
        generateContent: generateContentMockLocal,
      },
    };
  });
  return {
    createGoogleGenAIMock: createGoogleGenAIMockLocal,
    generateContentMock: generateContentMockLocal,
  };
});

vi.mock("./google-genai-runtime.js", () => ({
  createGoogleGenAI: createGoogleGenAIMock,
}));

import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import { expectExplicitMusicGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { buildGoogleMusicGenerationProvider } from "./music-generation-provider.js";

type GoogleGenAIConfig = {
  apiKey?: string;
  httpOptions?: {
    baseUrl?: string;
    timeout?: number;
  };
};

type GenerateContentRequest = {
  model?: string;
  config?: unknown;
};

function lastGoogleGenAIConfig(): GoogleGenAIConfig {
  const calls = createGoogleGenAIMock.mock.calls as unknown[][];
  const config = calls.at(-1)?.[0];
  if (!config) {
    throw new Error("Expected GoogleGenAI config");
  }
  return config as GoogleGenAIConfig;
}

function allGoogleGenAIConfigs(): GoogleGenAIConfig[] {
  return (createGoogleGenAIMock.mock.calls as unknown[][]).map((call) => {
    const config = call[0];
    if (!config) {
      throw new Error("Expected GoogleGenAI config");
    }
    return config as GoogleGenAIConfig;
  });
}

function firstGenerateContentRequest(): GenerateContentRequest {
  const calls = generateContentMock.mock.calls as unknown[][];
  const request = calls[0]?.[0];
  if (!request) {
    throw new Error("Expected generateContent request");
  }
  return request as GenerateContentRequest;
}

function googleMusicAudioResponse(bytes = "mp3-bytes") {
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              inlineData: {
                data: Buffer.from(bytes).toString("base64"),
                mimeType: "audio/mpeg",
              },
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
  };
}

function mockGoogleAuth(): void {
  vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
    apiKey: "google-key",
    source: "env",
    mode: "api-key",
  });
}

describe("google music generation provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    generateContentMock.mockReset();
    createGoogleGenAIMock.mockClear();
  });

  afterAll(() => {
    vi.doUnmock("./google-genai-runtime.js");
    vi.resetModules();
  });

  it("declares explicit mode capabilities", () => {
    expectExplicitMusicGenerationCapabilities(buildGoogleMusicGenerationProvider());
  });

  it("advertises Gemini music generation with a config-only Google API key", () => {
    expect(
      buildGoogleMusicGenerationProvider().isConfigured?.({
        cfg: {
          models: {
            providers: {
              google: {
                apiKey: "google-config-only-key",
                baseUrl: "https://generativelanguage.googleapis.com/v1beta",
                models: [],
              },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("submits generation and returns inline audio bytes plus lyrics", async () => {
    mockGoogleAuth();
    generateContentMock.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              { text: "wake the city up" },
              {
                inlineData: {
                  data: Buffer.from("mp3-bytes").toString("base64"),
                  mimeType: "audio/mpeg",
                },
              },
            ],
          },
        },
      ],
    });

    const provider = buildGoogleMusicGenerationProvider();
    const result = await provider.generateMusic({
      provider: "google",
      model: "lyria-3-clip-preview",
      prompt: "upbeat synthpop anthem",
      cfg: {},
      instrumental: true,
    });

    const generateRequest = firstGenerateContentRequest();
    expect(generateRequest.model).toBe("lyria-3-clip-preview");
    expect(generateRequest.config).toEqual({
      responseModalities: ["AUDIO", "TEXT"],
    });
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]?.mimeType).toBe("audio/mpeg");
    expect(result.lyrics).toEqual(["wake the city up"]);
    expect(lastGoogleGenAIConfig().apiKey).toBe("google-key");
  });

  it.each([
    ["invalid alphabet", "not-base64!"],
    ["non-canonical pad bits", "ZE=="],
    ["mixed alphabet", "aGVsbG8+_"],
  ])("rejects %s in inline audio", async (_scenario, data) => {
    mockGoogleAuth();
    generateContentMock.mockResolvedValue({
      candidates: [
        {
          content: { parts: [{ inlineData: { data, mimeType: "audio/mpeg" } }] },
          finishReason: "STOP",
        },
      ],
    });

    await expect(
      buildGoogleMusicGenerationProvider().generateMusic({
        provider: "google",
        model: "lyria-3-clip-preview",
        prompt: "upbeat synthpop anthem",
        cfg: {},
      }),
    ).rejects.toThrow("Generated music asset contains malformed base64 audio data");

    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it("accepts inline audio encoded with URL-safe base64", async () => {
    mockGoogleAuth();
    const audio = Buffer.from([0xfb, 0xff, 0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
    const audioBase64url = audio.toString("base64url");
    expect(audioBase64url).toMatch(/[-_]/);
    expect(audioBase64url).not.toMatch(/[+/]/);
    generateContentMock.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [{ inlineData: { data: audioBase64url, mimeType: "audio/mpeg" } }],
          },
          finishReason: "STOP",
        },
      ],
    });

    const result = await buildGoogleMusicGenerationProvider().generateMusic({
      provider: "google",
      model: "lyria-3-clip-preview",
      prompt: "upbeat synthpop anthem",
      cfg: {},
    });

    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]?.buffer).toEqual(audio);
  });

  it("retries once when Lyria returns an unblocked text-only response", async () => {
    mockGoogleAuth();
    generateContentMock
      .mockResolvedValueOnce({
        candidates: [
          {
            content: { parts: [{ text: "[Verse]\nNeon lights" }] },
            finishReason: "STOP",
          },
        ],
      })
      .mockResolvedValueOnce(googleMusicAudioResponse("recovered-audio"));

    const result = await buildGoogleMusicGenerationProvider().generateMusic({
      provider: "google",
      model: "lyria-3-clip-preview",
      prompt: "upbeat synthpop anthem",
      cfg: {},
      instrumental: true,
    });

    expect(generateContentMock).toHaveBeenCalledTimes(2);
    expect(result.tracks[0]?.buffer).toEqual(Buffer.from("recovered-audio"));
  });

  it("shares the configured timeout budget across a no-audio retry", async () => {
    mockGoogleAuth();
    vi.spyOn(Date, "now")
      // buildTimeoutAbortSignal (covering credential preparation) and
      // createProviderOperationDeadline each read Date.now() before the first
      // HTTP attempt, so both see the same starting instant.
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValue(2_500);
    generateContentMock
      .mockResolvedValueOnce({
        candidates: [
          {
            content: { parts: [{ text: "[Verse]\nNeon lights" }] },
            finishReason: "STOP",
          },
        ],
      })
      .mockResolvedValueOnce(googleMusicAudioResponse("recovered-audio"));

    await buildGoogleMusicGenerationProvider().generateMusic({
      provider: "google",
      model: "lyria-3-clip-preview",
      prompt: "upbeat synthpop anthem",
      cfg: {},
      timeoutMs: 5_000,
    });

    expect(allGoogleGenAIConfigs().map((config) => config.httpOptions?.timeout)).toEqual([
      5_000, 3_500,
    ]);
  });

  // Regression: when credential preparation is slow (OAuth refresh, profile lock
  // contention), the time it consumes must be subtracted from the shared
  // operation budget so the HTTP attempt receives only the remaining time, not
  // a fresh full timeout. Pre-fix the deadline was created after credential
  // lookup, so a delayed-but-successful auth granted HTTP a full budget.
  it("deducts delayed credential preparation from the HTTP timeout budget", async () => {
    // For an explicit timeout, the deadline is created before credential lookup
    // so the abort signal and the SDK deadline share the same budget. A slow
    // OAuth refresh that advances the clock consumes part of that budget; the
    // SDK attempt then receives only the remaining time, not a fresh full timeout.
    vi.spyOn(Date, "now")
      // buildTimeoutAbortSignal reads Date.now() for its setTimeout log.
      .mockReturnValueOnce(1_000)
      // createProviderOperationDeadline reads Date.now() before credential
      // lookup, establishing deadlineAtMs = start + timeoutMs (1000 + 5000 = 6000).
      .mockReturnValueOnce(1_000)
      // The credential refresh path reads Date.now() (simulating a real
      // resolver that timestamps its refresh), advancing the clock.
      .mockReturnValueOnce(2_500)
      // The HTTP attempt reads Date.now() and receives the remaining budget
      // (6000 - 2500 = 3500), not a fresh full timeout.
      .mockReturnValue(2_500);
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockImplementation(async () => {
      // Simulate slow OAuth refresh / profile lock contention that resolves
      // successfully after consuming part of the operation budget. A real
      // resolver timestamps its refresh, which reads Date.now() and advances
      // the observed clock past the deadline's starting instant.
      void Date.now();
      return { apiKey: "google-key", source: "env", mode: "api-key" };
    });
    generateContentMock.mockResolvedValueOnce(googleMusicAudioResponse("recovered-audio"));

    await buildGoogleMusicGenerationProvider().generateMusic({
      provider: "google",
      model: "lyria-3-clip-preview",
      prompt: "upbeat synthpop anthem",
      cfg: {},
      timeoutMs: 5_000,
    });

    // Post-fix: deadlineAtMs (1000 + 5000 = 6000) minus the post-credential
    // instant (2500) leaves 3500ms for the HTTP attempt.
    expect(allGoogleGenAIConfigs().map((config) => config.httpOptions?.timeout)).toEqual([3_500]);
  });

  it("fails after one retry when Lyria keeps returning no audio", async () => {
    mockGoogleAuth();
    generateContentMock.mockResolvedValue({
      candidates: [
        {
          content: { parts: [{ text: "[Verse]\nStill no audio" }] },
          finishReason: "STOP",
        },
      ],
    });

    await expect(
      buildGoogleMusicGenerationProvider().generateMusic({
        provider: "google",
        model: "lyria-3-clip-preview",
        prompt: "upbeat synthpop anthem",
        cfg: {},
      }),
    ).rejects.toThrow("Google music generation response missing audio data");

    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      expectedError: "prompt blocked (SAFETY)",
      response: { promptFeedback: { blockReason: "SAFETY" } },
      scenario: "prompt block",
    },
    {
      expectedError: "generation stopped (SAFETY)",
      response: { candidates: [{ finishReason: "SAFETY" }] },
      scenario: "candidate stop",
    },
  ])("does not retry a terminal $scenario response", async ({ expectedError, response }) => {
    mockGoogleAuth();
    generateContentMock.mockResolvedValue(response);

    await expect(
      buildGoogleMusicGenerationProvider().generateMusic({
        provider: "google",
        model: "lyria-3-clip-preview",
        prompt: "upbeat synthpop anthem",
        cfg: {},
      }),
    ).rejects.toThrow(expectedError);

    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry request errors", async () => {
    mockGoogleAuth();
    generateContentMock.mockRejectedValue(new Error("HTTP 400 invalid request"));

    await expect(
      buildGoogleMusicGenerationProvider().generateMusic({
        provider: "google",
        model: "lyria-3-clip-preview",
        prompt: "upbeat synthpop anthem",
        cfg: {},
      }),
    ).rejects.toThrow("HTTP 400 invalid request");

    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  const baseUrlCases: Array<{
    name: string;
    baseUrl?: string;
    expectedBaseUrl?: string;
    prompt: string;
    audio: string;
  }> = [
    {
      name: "strips /v1beta suffix from configured baseUrl before passing to GoogleGenAI SDK",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      expectedBaseUrl: "https://generativelanguage.googleapis.com",
      prompt: "ambient ocean",
      audio: "mp3-bytes",
    },
    {
      name: "does NOT strip /v1beta when it appears mid-path (end-anchor proof)",
      baseUrl: "https://proxy.example.com/v1beta/route",
      expectedBaseUrl: "https://proxy.example.com/v1beta/route",
      prompt: "test",
      audio: "x",
    },
    {
      name: "passes baseUrl unchanged when no /v1beta suffix is present",
      baseUrl: "https://generativelanguage.googleapis.com",
      expectedBaseUrl: "https://generativelanguage.googleapis.com",
      prompt: "test",
      audio: "x",
    },
    {
      name: "does not set baseUrl when none is configured",
      prompt: "test",
      audio: "x",
    },
  ];

  it.each(baseUrlCases)("$name", async ({ baseUrl, expectedBaseUrl, prompt, audio }) => {
    mockGoogleAuth();
    generateContentMock.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  data: Buffer.from(audio).toString("base64"),
                  mimeType: "audio/mpeg",
                },
              },
            ],
          },
        },
      ],
    });

    await buildGoogleMusicGenerationProvider().generateMusic({
      provider: "google",
      model: "lyria-3-clip-preview",
      prompt,
      cfg: baseUrl ? { models: { providers: { google: { baseUrl, models: [] } } } } : {},
      instrumental: true,
    });

    expect(lastGoogleGenAIConfig().httpOptions?.baseUrl).toBe(expectedBaseUrl);
  });

  it("rejects unsupported wav output on clip model", async () => {
    mockGoogleAuth();
    const provider = buildGoogleMusicGenerationProvider();

    await expect(
      provider.generateMusic({
        provider: "google",
        model: "lyria-3-clip-preview",
        prompt: "ambient ocean",
        cfg: {},
        format: "wav",
      }),
    ).rejects.toThrow("supports mp3 output");
  });

  // Regression: credential preparation (OAuth refresh, profile lock) must share
  // the request timeout budget. resolveApiKeyForProvider is called before the
  // operation deadline and must receive an abort signal so a stalled credential
  // lookup is cancelled within req.timeoutMs instead of hanging indefinitely.
  it("aborts credential preparation when it exceeds the request timeout", async () => {
    // Mirrors resolveApiKeyForProviderCore: honors the caller's signal by
    // rejecting when aborted (the real impl calls throwIfAborted() across the
    // OAuth refresh path). Without a signal (pre-fix), the wait is unbounded.
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockImplementation(
      (params: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const signal = params.signal;
          if (!signal) {
            return;
          }
          if (signal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );

    // Controlled clock: buildTimeoutAbortSignal arms a setTimeout for the
    // configured budget. Advancing the fake clock deterministically fires the
    // timeout, aborting the credential wait without real wall-clock delay.
    vi.useFakeTimers();
    try {
      const promise = buildGoogleMusicGenerationProvider().generateMusic({
        provider: "google",
        model: "lyria-3-clip-preview",
        prompt: "upbeat synthpop anthem",
        cfg: {},
        timeoutMs: 200,
      });

      // Attach the rejection assertion before advancing the clock so the
      // abort listener's reject is never momentarily unhandled.
      const assertion = expect(promise).rejects.toThrow(/timed out|aborted/i);

      // Before the timeout fires, credential lookup is still pending and no
      // HTTP attempt has started.
      expect(generateContentMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(200);
      await assertion;

      expect(generateContentMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  }, 5_000);

  // Regression: an omitted timeout must preserve the existing behavior — no
  // absolute deadline is imposed on credential preparation. buildTimeoutAbortSignal
  // returns no signal when timeoutMs is undefined, so a slow OAuth refresh is not
  // cancelled by the DEFAULT_TIMEOUT_MS fallback (only the HTTP/SDK layer keeps
  // its per-request default). This guards the compatibility decision: the
  // 180-second default must not silently extend into credential waits that
  // previously remained unbounded.
  it("does not apply an abort signal to credential preparation when timeout is omitted", async () => {
    let receivedSignal: AbortSignal | undefined;
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockImplementation(
      (params: { signal?: AbortSignal }) => {
        receivedSignal = params.signal;
        return new Promise(() => {
          // Never resolves; the point is to observe whether a signal was attached,
          // not to complete the request. Without a timeout, no abort fires.
        });
      },
    );

    vi.useFakeTimers();
    try {
      // No timeoutMs: credential preparation must run without an abort signal.
      const promise = buildGoogleMusicGenerationProvider().generateMusic({
        provider: "google",
        model: "lyria-3-clip-preview",
        prompt: "upbeat synthpop anthem",
        cfg: {},
      });

      // Advance well past the DEFAULT_TIMEOUT_MS (180s). With the fix, no signal
      // was created, so credential preparation is still pending (not aborted) and
      // no HTTP attempt has started.
      await vi.advanceTimersByTimeAsync(360_000);

      expect(receivedSignal).toBeUndefined();
      expect(generateContentMock).not.toHaveBeenCalled();

      // Clean up the hanging promise to avoid unhandled rejection noise.
      promise.catch(() => {});
    } finally {
      vi.useRealTimers();
    }
  }, 5_000);

  // Regression (ClawSweeper P1, Revision 8): when timeoutMs is omitted, the
  // operation deadline must be created after credential lookup (matching main),
  // not before. Otherwise a slow OAuth refresh that takes longer than
  // DEFAULT_TIMEOUT_MS (180s) but eventually succeeds would find the deadline
  // already expired, and resolveProviderOperationTimeoutMs would throw before the
  // generation request — a compatibility regression where main would proceed.
  it("proceeds to the generation request when omitted-timeout credentials resolve after the default deadline", async () => {
    // Slow credential lookup that resolves successfully after the 180s default
    // would have expired if a deadline were started before authentication.
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockImplementation(async () => {
      // Simulate a contended OAuth refresh that eventually succeeds.
      await new Promise((resolve) => {
        setTimeout(resolve, 200_000);
      });
      return { apiKey: "google-key", source: "env", mode: "api-key" };
    });
    generateContentMock.mockResolvedValueOnce(googleMusicAudioResponse("late-auth-audio"));

    vi.useFakeTimers();
    try {
      const promise = buildGoogleMusicGenerationProvider().generateMusic({
        provider: "google",
        model: "lyria-3-clip-preview",
        prompt: "upbeat synthpop anthem",
        cfg: {},
      });

      // Advance past the DEFAULT_TIMEOUT_MS (180s) that a pre-lookup deadline
      // would have imposed. Credential resolution completes at 200s.
      await vi.advanceTimersByTimeAsync(200_000);

      // The generation request must still proceed — the deadline was created
      // after credential lookup, so it has not expired.
      await vi.waitFor(() => {
        expect(generateContentMock).toHaveBeenCalledTimes(1);
      });

      const result = await promise;
      expect(result.tracks[0]?.buffer).toEqual(Buffer.from("late-auth-audio"));
    } finally {
      vi.useRealTimers();
    }
  }, 5_000);

  // Regression (ClawSweeper P2, Revision 9): when timeoutMs is omitted, the
  // 180-second shared retry deadline (created after credential lookup, matching
  // main) must bound the no-audio retry loop. Each SDK attempt receives only the
  // remaining budget, not a fresh full 180 seconds — otherwise a no-audio retry
  // could take roughly twice the previous generation budget.
  it("shares the default deadline across no-audio retries when timeout is omitted", async () => {
    // credential lookup is immediate (mockGoogleAuth), so the deadline starts at
    // the same instant as credential resolution. The first SDK attempt advances
    // the clock; the retry must receive the remaining budget, not a fresh 180s.
    mockGoogleAuth();
    vi.spyOn(Date, "now")
      // createProviderOperationDeadline (after credential lookup) reads Date.now()
      // to establish deadlineAtMs = start + DEFAULT_TIMEOUT_MS (180s).
      .mockReturnValueOnce(1_000)
      // First SDK attempt reads Date.now() and receives the full 180s.
      .mockReturnValueOnce(1_000)
      // After the first attempt returns no audio, the clock has advanced (e.g.
      // the SDK timed out at 100s). The retry reads Date.now() here.
      .mockReturnValue(101_000);
    generateContentMock
      .mockResolvedValueOnce({
        candidates: [
          {
            content: { parts: [{ text: "[Verse]\nNeon lights" }] },
            finishReason: "STOP",
          },
        ],
      })
      .mockResolvedValueOnce(googleMusicAudioResponse("recovered-audio"));

    await buildGoogleMusicGenerationProvider().generateMusic({
      provider: "google",
      model: "lyria-3-clip-preview",
      prompt: "upbeat synthpop anthem",
      cfg: {},
      // No timeoutMs: the default 180s shared deadline must bound the retry.
    });

    // deadlineAtMs (1000 + 180000 = 181000) minus the retry instant (101000)
    // leaves 80000ms — not a fresh full 180000ms.
    expect(allGoogleGenAIConfigs().map((config) => config.httpOptions?.timeout)).toEqual([
      180_000, 80_000,
    ]);
  }, 5_000);
});

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeModelFallbackCfg } from "../test-helpers/model-fallback-config-fixture.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  MockedFailoverError,
  mockedClassifyFailoverReason,
  mockedFormatAssistantErrorText,
  mockedGlobalHookRunner,
  mockedIsFailoverAssistantError,
  mockedIsRateLimitAssistantError,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

describe("runEmbeddedPiAgent rate-limit model fallback", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
  });

  it("throws FailoverError for rate-limit assistant error with non-error stopReason when fallbacks configured", async () => {
    // Simulate a provider SDK that absorbs 429 internally and returns
    // with stopReason "toolUse" instead of "error".
    mockedClassifyFailoverReason.mockReturnValue("rate_limit");
    mockedIsFailoverAssistantError.mockReturnValue(false);
    mockedIsRateLimitAssistantError.mockReturnValue(false);
    mockedFormatAssistantErrorText.mockReturnValue("⚠️ API rate limit reached.");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          stopReason: "toolUse",
          errorMessage: "429 Resource has been exhausted (e.g. check quota).",
          provider: "google",
          model: "gemini-2.5-pro",
        } as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const promise = runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-rate-limit-non-error-stop",
      config: makeModelFallbackCfg({
        agents: {
          defaults: {
            model: {
              primary: "google/gemini-2.5-pro",
              fallbacks: ["anthropic/claude-sonnet-4-6"],
            },
          },
        },
      }),
    });

    await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
  });

  it("throws FailoverError for incomplete turn (mid-turn 429) when fallbacks configured", async () => {
    mockedClassifyFailoverReason.mockReturnValue("rate_limit");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        toolMetas: [],
        lastAssistant: {
          stopReason: "toolUse",
          errorMessage: "429 Too Many Requests",
          provider: "google",
          model: "gemini-2.5-pro",
        } as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const promise = runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-incomplete-turn-fallback",
      config: makeModelFallbackCfg({
        agents: {
          defaults: {
            model: {
              primary: "google/gemini-2.5-pro",
              fallbacks: ["anthropic/claude-sonnet-4-6"],
            },
          },
        },
      }),
    });

    await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
  });

  it("returns error (not throws) for rate-limit when NO fallbacks configured", async () => {
    mockedClassifyFailoverReason.mockReturnValue("rate_limit");
    mockedIsFailoverAssistantError.mockReturnValue(false);
    mockedIsRateLimitAssistantError.mockReturnValue(false);
    mockedFormatAssistantErrorText.mockReturnValue("⚠️ API rate limit reached.");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["⚠️ API rate limit reached."],
        lastAssistant: {
          stopReason: "toolUse",
          errorMessage: "429 Resource has been exhausted",
          provider: "google",
          model: "gemini-2.5-pro",
        } as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    // No fallbacks configured — should return normally, not throw.
    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-rate-limit-no-fallbacks",
      config: {
        agents: {
          defaults: {
            model: {
              primary: "google/gemini-2.5-pro",
            },
          },
        },
      } as Parameters<typeof runEmbeddedPiAgent>[0]["config"],
    });

    expect(result).toBeDefined();
    expect(result.payloads).toBeDefined();
  });

  it("throws FailoverError for timeout with empty payloads when fallbacks configured", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        timedOutDuringCompaction: false,
        assistantTexts: [],
        lastAssistant: undefined,
      }),
    );

    const promise = runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-timeout-fallback",
      config: makeModelFallbackCfg({
        agents: {
          defaults: {
            model: {
              primary: "google/gemini-2.5-pro",
              fallbacks: ["anthropic/claude-sonnet-4-6"],
            },
          },
        },
      }),
    });

    await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
  });
});

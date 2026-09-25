import type { Mock } from "vitest";
import type { EmbeddedRunAttemptResult } from "./embedded-agent-runner/run/types.js";
import { FailoverError } from "./failover-error.js";
import {
  type EmbeddedAttemptParams,
  makeFallbackSuccessAttempt,
  OVERLOADED_ERROR_PAYLOAD,
  RATE_LIMIT_ERROR_MESSAGE,
} from "./model-fallback.run-embedded.e2e.test-support.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";

/** Deterministic primary failures for the shared embedded-runner fallback harness. */
export function createModelFallbackAttemptMocks(
  runEmbeddedAttemptMock: Pick<
    Mock<(params: unknown) => Promise<EmbeddedRunAttemptResult>>,
    "mockImplementation"
  >,
) {
  function mockPrimaryFailureThenFallbackSuccess(
    makePrimaryAttempt: (
      attemptParams: EmbeddedAttemptParams,
    ) => EmbeddedRunAttemptResult | Promise<EmbeddedRunAttemptResult>,
    options?: { primaryProvider?: string },
  ) {
    const primaryProvider = options?.primaryProvider ?? "openai";
    runEmbeddedAttemptMock.mockImplementation(async (params: unknown) => {
      const attemptParams = params as EmbeddedAttemptParams;
      if (attemptParams.provider === primaryProvider) {
        // Keep route/receipt scenarios bounded with a provider-reported retry cap.
        return { ...(await makePrimaryAttempt(attemptParams)), providerRetryMaxRetries: 3 };
      }
      if (attemptParams.provider === "groq") {
        return makeFallbackSuccessAttempt();
      }
      throw new Error(`Unexpected provider ${attemptParams.provider}`);
    });
  }

  function mockPrimaryErrorThenFallbackSuccess(
    errorMessage: string,
    options?: { primaryProvider?: string },
  ) {
    mockPrimaryFailureThenFallbackSuccess(
      (attemptParams) =>
        makeEmbeddedRunnerAttempt({
          assistantTexts: [],
          lastAssistant: buildEmbeddedRunnerAssistant({
            provider: attemptParams.provider,
            model: attemptParams.modelId ?? "mock-1",
            stopReason: "error",
            errorMessage,
          }),
        }),
      options,
    );
  }

  return {
    mockPrimaryFailureThenFallbackSuccess,
    mockPrimaryErrorThenFallbackSuccess,
    mockPrimaryOverloadedThenFallbackSuccess: () =>
      mockPrimaryErrorThenFallbackSuccess(OVERLOADED_ERROR_PAYLOAD),
    mockPrimaryPromptErrorThenFallbackSuccess: (errorMessage: string) =>
      mockPrimaryFailureThenFallbackSuccess(() =>
        makeEmbeddedRunnerAttempt({
          terminal: { kind: "failed", source: "prompt", error: new Error(errorMessage) },
        }),
      ),
    mockPrimarySuspendingPromptErrorThenFallbackSuccess: (sessionId: string) =>
      mockPrimaryFailureThenFallbackSuccess(() =>
        makeEmbeddedRunnerAttempt({
          sessionIdUsed: sessionId,
          terminal: {
            kind: "failed",
            source: "prompt",
            error: new FailoverError(RATE_LIMIT_ERROR_MESSAGE, {
              reason: "rate_limit",
              provider: "openai",
              model: "mock-1",
              suspend: true,
            }),
          },
        }),
      ),
    mockPrimaryStaleRateLimitTextSuccess: (errorMessage: string) =>
      mockPrimaryFailureThenFallbackSuccess(() =>
        makeEmbeddedRunnerAttempt({
          assistantTexts: ["primary ok"],
          lastAssistant: buildEmbeddedRunnerAssistant({
            provider: "openai",
            model: "mock-1",
            stopReason: "stop",
            content: [{ type: "text", text: "primary ok" }],
            errorMessage,
          }),
        }),
      ),
  };
}

import type { Mock } from "vitest";
import type { EmbeddedRunAttemptResult as Attempt } from "./embedded-agent-runner/run/types.js";
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

export function createModelFallbackAttemptMocks(
  runEmbeddedAttemptMock: Pick<Mock<(params: unknown) => Promise<Attempt>>, "mockImplementation">,
) {
  function primaryFailure(
    makePrimaryAttempt: (params: EmbeddedAttemptParams) => Attempt | Promise<Attempt>,
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

  function primaryError(errorMessage: string, options?: { primaryProvider?: string }) {
    primaryFailure(
      (attemptParams) =>
        makeEmbeddedRunnerAttempt({
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

  function mockPromptFailure(makeError: () => Error, sessionIdUsed?: string) {
    primaryFailure(() =>
      makeEmbeddedRunnerAttempt({
        ...(sessionIdUsed !== undefined ? { sessionIdUsed } : {}),
        terminal: { kind: "failed", source: "prompt", error: makeError() },
      }),
    );
  }

  return {
    mockPrimaryFailureThenFallbackSuccess: primaryFailure,
    mockPrimaryErrorThenFallbackSuccess: primaryError,
    mockPrimaryOverloadedThenFallbackSuccess: () => primaryError(OVERLOADED_ERROR_PAYLOAD),
    mockPrimaryPromptErrorThenFallbackSuccess: (errorMessage: string) =>
      mockPromptFailure(() => new Error(errorMessage)),
    mockPrimarySuspendingPromptErrorThenFallbackSuccess: (sessionId: string) =>
      mockPromptFailure(
        () =>
          new FailoverError(RATE_LIMIT_ERROR_MESSAGE, {
            reason: "rate_limit",
            provider: "openai",
            model: "mock-1",
            suspend: true,
          }),
        sessionId,
      ),
    mockPrimaryStaleRateLimitTextSuccess: (errorMessage: string) =>
      primaryFailure(() =>
        makeEmbeddedRunnerAttempt({
          assistantTexts: ["primary ok"],
          lastAssistant: buildEmbeddedRunnerAssistant({
            content: [{ type: "text", text: "primary ok" }],
            errorMessage,
          }),
        }),
      ),
  };
}

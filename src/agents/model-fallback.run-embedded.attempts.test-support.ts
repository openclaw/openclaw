import type { Mock } from "vitest";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult as Attempt,
} from "./embedded-agent-runner/run/types.js";
import {
  type EmbeddedAttemptParams,
  makeFallbackSuccessAttempt,
} from "./model-fallback.run-embedded.e2e.test-support.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";

export function createModelFallbackAttemptMocks(
  runEmbeddedAttemptMock: Pick<
    Mock<(params: EmbeddedRunAttemptParams) => Promise<Attempt>>,
    "mockImplementation"
  >,
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

  return {
    mockPrimaryFailureThenFallbackSuccess: primaryFailure,
    mockPrimaryErrorThenFallbackSuccess: primaryError,
  };
}

/**
 * Tests that the assistant-error branch in run.ts invokes isLikelySSEParseError
 * with explicit { streamingContext: true } so that stack-less errors like
 * "SyntaxError: Unexpected end of JSON input" are correctly detected and retried.
 */
import "./run.overflow-compaction.mocks.shared.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEmbeddedPiAgent } from "./run.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import { mockedGlobalHookRunner } from "./run.overflow-compaction.mocks.shared.js";
import {
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
} from "./run.overflow-compaction.shared-test.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

// Access the mocked isLikelySSEParseError through the module mock.
// The shared mock file replaces ../pi-embedded-helpers.js entirely, so we
// access it via require to get the mock reference after vi.mock runs.
const helpers = await vi.importMock<typeof import("../pi-embedded-helpers.js")>(
  "../pi-embedded-helpers.js",
);
const mockedIsLikelySSEParseError = helpers.isLikelySSEParseError as unknown as ReturnType<
  typeof vi.fn
>;

function makeAssistantError(errorMessage: string): EmbeddedRunAttemptResult["lastAssistant"] {
  return {
    role: "assistant",
    stopReason: "error",
    errorMessage,
    content: [],
  } as unknown as EmbeddedRunAttemptResult["lastAssistant"];
}

describe("run.ts SSE parse error retry – assistant-error branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
  });

  it("passes { streamingContext: true } when classifying assistant errors", async () => {
    const sseErrorMessage = "SyntaxError: Unexpected end of JSON input";

    // First attempt: assistant returns with stopReason "error" and SSE-like message
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: null,
        lastAssistant: makeAssistantError(sseErrorMessage),
        assistantTexts: [],
      }),
    );
    // Return true to trigger the retry path
    mockedIsLikelySSEParseError.mockReturnValueOnce(true);

    // Second attempt: success
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent(overflowBaseRunParams);

    // Verify isLikelySSEParseError was called with { streamingContext: true }
    const callsWithStreamingContext = mockedIsLikelySSEParseError.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[1] === "object" &&
        args[1] !== null &&
        (args[1] as { streamingContext?: boolean }).streamingContext === true,
    );
    expect(callsWithStreamingContext.length).toBeGreaterThanOrEqual(1);
    expect(callsWithStreamingContext[0]?.[0]).toBe(sseErrorMessage);
  });

  it("retries on assistant SSE parse error and succeeds on second attempt", async () => {
    const sseErrorMessage = "SyntaxError: Unexpected end of JSON input";

    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: null,
        lastAssistant: makeAssistantError(sseErrorMessage),
        assistantTexts: [],
      }),
    );
    mockedIsLikelySSEParseError.mockReturnValueOnce(true);

    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ promptError: null, assistantTexts: ["Success!"] }),
    );

    await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });

  it("does NOT pass { streamingContext: true } for prompt-error SSE classification", async () => {
    const sseError = new Error("SyntaxError: Unexpected end of JSON input");
    sseError.stack = "Error: SyntaxError\n    at streaming.js:42";

    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: sseError }));
    mockedIsLikelySSEParseError.mockReturnValueOnce(true);

    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent(overflowBaseRunParams);

    // The prompt-error branch should pass the stack string, not an options object
    const firstCall = mockedIsLikelySSEParseError.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(typeof firstCall[1]).not.toBe("object");
  });
});

/**
 * Error Mapping Contract Tests
 *
 * Derived from: implementation-plan.md Section 4.6 (error classification mapping),
 * test-specifications.md Section 6 (error mapping contract tests),
 * pi-runtime-baseline.md Section 7 (error classification functions).
 *
 * Verifies that mapSdkError() produces errors whose messages pass through the
 * existing Pi raw error classification functions. Classification is tested on
 * the mapped error's message string using the *Message() variants (which accept
 * raw strings), since the *AssistantError() variants require AssistantMessage objects.
 */

import { describe, it, expect } from "vitest";
import {
  classifyFailoverReason,
  isAuthErrorMessage,
  isRateLimitErrorMessage,
  isTimeoutErrorMessage,
  isLikelyContextOverflowError,
  isFailoverErrorMessage,
} from "../pi-embedded-helpers/errors.js";
import { isRunnerAbortError } from "../pi-embedded-runner/abort.js";
import {
  isStaleClaudeResumeSessionError,
  isStaleClaudeResumeSessionErrorMessage,
  mapSdkError,
} from "./error-mapping.js";

// ---------------------------------------------------------------------------
// Helpers: create mock SDK errors by name
// ---------------------------------------------------------------------------

function makeSdkError(name: string, message: string, status?: number): Error {
  const err = new Error(message);
  err.name = name;
  if (status !== undefined) {
    (err as unknown as Record<string, unknown>).status = status;
  }
  return err;
}

// ---------------------------------------------------------------------------
// Section 6: Error Mapping Contract Tests
// ---------------------------------------------------------------------------

describe("error mapping — AuthenticationError", () => {
  it("maps AuthenticationError so isAuthErrorMessage() returns true", () => {
    const sdkError = makeSdkError("AuthenticationError", "Invalid API key provided");
    const mapped = mapSdkError(sdkError) as Error;

    expect(mapped).toBeInstanceOf(Error);
    expect(isAuthErrorMessage(mapped.message)).toBe(true);
  });

  it("maps auth error with '401' in message", () => {
    const sdkError = makeSdkError("AuthenticationError", "401 Unauthorized");
    const mapped = mapSdkError(sdkError) as Error;

    expect(isAuthErrorMessage(mapped.message)).toBe(true);
  });
});

describe("error mapping — RateLimitError", () => {
  it("maps RateLimitError so isRateLimitErrorMessage() returns true", () => {
    const sdkError = makeSdkError("RateLimitError", "429 Too Many Requests");
    const mapped = mapSdkError(sdkError) as Error;

    expect(mapped).toBeInstanceOf(Error);
    expect(isRateLimitErrorMessage(mapped.message)).toBe(true);
  });

  it("maps error with 'rate_limit' in message", () => {
    const sdkError = makeSdkError("RateLimitError", "rate_limit_exceeded for model");
    const mapped = mapSdkError(sdkError) as Error;

    expect(isRateLimitErrorMessage(mapped.message)).toBe(true);
  });
});

describe("error mapping — APIError 5xx (failover)", () => {
  it("maps APIError with status 500 so isFailoverErrorMessage() returns true", () => {
    const sdkError = makeSdkError("APIError", "Internal Server Error", 500);
    const mapped = mapSdkError(sdkError) as Error;

    expect(mapped).toBeInstanceOf(Error);
    expect(isFailoverErrorMessage(mapped.message)).toBe(true);
  });

  it("maps APIConnectionError so isFailoverErrorMessage() returns true", () => {
    const sdkError = makeSdkError("APIConnectionError", "Connection refused");
    const mapped = mapSdkError(sdkError) as Error;

    expect(isFailoverErrorMessage(mapped.message)).toBe(true);
  });
});

describe("error mapping — APIConnectionTimeoutError (timeout)", () => {
  it("maps APIConnectionTimeoutError so isTimeoutErrorMessage() returns true", () => {
    const sdkError = makeSdkError("APIConnectionTimeoutError", "Request timed out after 30s");
    const mapped = mapSdkError(sdkError) as Error;

    expect(mapped).toBeInstanceOf(Error);
    expect(isTimeoutErrorMessage(mapped.message)).toBe(true);
  });

  it("maps error with 'timeout' in message", () => {
    const sdkError = makeSdkError("TimeoutError", "Connection timeout");
    const mapped = mapSdkError(sdkError) as Error;

    expect(isTimeoutErrorMessage(mapped.message)).toBe(true);
  });
});

describe("error mapping — BadRequestError with context overflow", () => {
  it("maps context overflow BadRequestError so isLikelyContextOverflowError() returns true", () => {
    const sdkError = makeSdkError(
      "BadRequestError",
      "prompt is too long: Input exceeds context window limit",
    );
    const mapped = mapSdkError(sdkError) as Error;

    expect(mapped).toBeInstanceOf(Error);
    expect(isLikelyContextOverflowError(mapped.message)).toBe(true);
  });

  it("maps context length exceeded message", () => {
    const sdkError = makeSdkError(
      "BadRequestError",
      "Context length exceeded the maximum token limit",
    );
    const mapped = mapSdkError(sdkError) as Error;

    expect(isLikelyContextOverflowError(mapped.message)).toBe(true);
  });
});

describe("error mapping — stale resume session errors", () => {
  it("detects stale resume errors by message heuristics", () => {
    expect(
      isStaleClaudeResumeSessionErrorMessage("Resume failed: session not found on server"),
    ).toBe(true);
    expect(isStaleClaudeResumeSessionErrorMessage("Model not found")).toBe(false);
  });

  it("maps stale resume errors with explicit marker prefix for runtime recovery", () => {
    const sdkError = makeSdkError("BadRequestError", "invalid session id for resume request");
    const mapped = mapSdkError(sdkError) as Error;

    expect(isStaleClaudeResumeSessionError(mapped)).toBe(true);
    expect(mapped.message).toContain("claude_sdk_stale_resume_session");
  });
});

describe("error mapping — AbortError (runtime-agnostic)", () => {
  it("passes AbortError through isRunnerAbortError() without mapping", () => {
    const abortError = new Error("Aborted");
    abortError.name = "AbortError";

    // AbortError is passed through as-is by mapSdkError
    const mapped = mapSdkError(abortError);
    expect(mapped).toBe(abortError); // same reference, not a new error

    expect(isRunnerAbortError(mapped)).toBe(true);
  });

  it("mapSdkError preserves AbortError identity", () => {
    const abort = new DOMException("Aborted", "AbortError");
    expect(mapSdkError(abort)).toBe(abort);
    expect(isRunnerAbortError(abort)).toBe(true);
  });
});

describe("error mapping — unknown errors pass through", () => {
  it("passes through errors that do not match any SDK pattern", () => {
    const unknown = new Error("Something completely unexpected");
    const mapped = mapSdkError(unknown);
    // Should be returned as-is or with no meaningful change
    expect(mapped).toBe(unknown);
  });

  it("passes through non-Error values unchanged", () => {
    const strErr = "plain string error";
    expect(mapSdkError(strErr)).toBe(strErr);

    const numErr = 42;
    expect(mapSdkError(numErr)).toBe(numErr);
  });
});

describe("error mapping — mapped errors have cause chain", () => {
  it("mapped error has original SDK error as cause", () => {
    const original = makeSdkError("AuthenticationError", "invalid api key");
    const mapped = mapSdkError(original) as Error;

    // The cause chain preserves the original for debugging
    expect((mapped as Error & { cause?: unknown }).cause).toBe(original);
  });
});

describe("error mapping — thrown prompt errors stay failover-classifiable", () => {
  it("maps auth SDK errors to string signals consumed by run.ts prompt-error path", () => {
    const sdkError = makeSdkError("AuthenticationError", "invalid key");
    const mapped = mapSdkError(sdkError) as Error;

    expect(mapped.name).toBe("AssistantError");
    expect(isFailoverErrorMessage(mapped.message)).toBe(true);
    expect(classifyFailoverReason(mapped.message)).toBe("auth");
  });

  it("maps 5xx SDK errors to retryable prompt failover reasons", () => {
    const sdkError = makeSdkError("APIError", "Server crashed", 503);
    const mapped = mapSdkError(sdkError) as Error;

    expect(isFailoverErrorMessage(mapped.message)).toBe(true);
    expect(["timeout", "rate_limit"]).toContain(classifyFailoverReason(mapped.message));
  });
});

import { describe, expect, it } from "vitest";
import { classifyFailoverReason, isFailoverErrorMessage } from "./errors.js";
import { isTimeoutErrorMessage } from "./failover-matches.js";

describe("classifyFailoverReason", () => {
  it("classifies known timeout messages", () => {
    expect(classifyFailoverReason("request timed out")).toBe("timeout");
    expect(classifyFailoverReason("deadline exceeded")).toBe("timeout");
    expect(classifyFailoverReason("connection error")).toBe("timeout");
  });

  it("classifies known rate limit messages", () => {
    expect(classifyFailoverReason("429 too many requests")).toBe("rate_limit");
  });

  it("returns null for unrecognized provider errors", () => {
    // These are real-world errors (e.g. from OpenRouter) that don't match
    // any known pattern.  The inner runner must handle them separately
    // when fallback models are configured (see run.ts).
    expect(classifyFailoverReason("Provider returned error")).toBeNull();
    expect(classifyFailoverReason("upstream provider error")).toBeNull();
    expect(classifyFailoverReason("unknown error occurred")).toBeNull();
  });
});

describe("isFailoverErrorMessage", () => {
  it("returns false for generic provider errors", () => {
    // Unrecognized errors are not classified as failover by pattern matching
    // alone.  The run loop handles these by checking lastAssistant.stopReason
    // === 'error' and throwing FailoverError when fallbacks are configured.
    expect(isFailoverErrorMessage("Provider returned error")).toBe(false);
  });

  it("returns true for recognized timeout errors", () => {
    expect(isFailoverErrorMessage("request timed out")).toBe(true);
  });
});

describe("isTimeoutErrorMessage", () => {
  it("matches cron job timeout message", () => {
    expect(isTimeoutErrorMessage("cron: job execution timed out")).toBe(true);
  });
});

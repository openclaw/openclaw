import { describe, expect, it } from "vitest";
import { buildRetryReport } from "./retry-report.js";

describe("buildRetryReport", () => {
  it("returns unused when no retries were consumed", () => {
    const report = buildRetryReport({
      generatedAt: Date.now(),
      maxAttempts: 8,
      attemptsUsed: 1,
      entries: [],
    });

    expect(report).toEqual(
      expect.objectContaining({
        status: "unused",
        maxAttempts: 8,
        attemptsUsed: 1,
        retriesUsed: 0,
        remainingRetries: 7,
      }),
    );
  });

  it("returns used when retries were consumed", () => {
    const report = buildRetryReport({
      generatedAt: Date.now(),
      maxAttempts: 8,
      attemptsUsed: 3,
      entries: [
        { attempt: 1, reason: "auth_refresh" },
        { attempt: 2, reason: "thinking_fallback" },
      ],
    });

    expect(report).toEqual(
      expect.objectContaining({
        status: "used",
        attemptsUsed: 3,
        retriesUsed: 2,
        remainingRetries: 5,
      }),
    );
    expect(report.entries).toHaveLength(2);
  });

  it("returns exhausted when retry limit was reached", () => {
    const report = buildRetryReport({
      generatedAt: Date.now(),
      maxAttempts: 8,
      attemptsUsed: 8,
      exhausted: true,
      entries: [{ attempt: 7, reason: "overflow_retry" }],
    });

    expect(report).toEqual(
      expect.objectContaining({
        status: "exhausted",
        exhaustedReason: "retry_limit",
        attemptsUsed: 8,
        remainingRetries: 0,
      }),
    );
  });
});
